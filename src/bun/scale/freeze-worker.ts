// Freeze worker — Phase 3 of the sleep lifecycle plan.
//
// Takes a server that has no running replicas (stopped anchors allowed) and
// drives it through the freeze flow:
//
//     pending -> snapshotting -> finalizing -> done
//
// The worker is fire-and-forget but the job row is persisted in `freeze_jobs`
// so a panel restart mid-flight resumes cleanly. Per-server in-memory
// context is kept in `activeCtx` so that (a) duplicate ticks don't double-run
// the same job and (b) wake.ts can cancel a freeze that is still in flight.
//
// Cancellation contract (from the plan):
//   - A wake request for the server aborts the job.
//   - If the snapshot create API call has already been issued, we cannot
//     cancel mid-flight — we wait for the image to settle and then delete it.
//   - If we're past "finalizing" (instance destroyed, server marked frozen),
//     cancellation is no longer possible — the wake must go through the
//     Phase 4 deep-wake path instead.
//   - On cancel, the server row is left untouched (still "materialized")
//     so the wake path can proceed.

import * as db from "../db.ts";
import { getComputeProvider, getDnsProvider } from "../providers/index.ts";
import {
  sshExec,
  deployPanelWakePage,
  ensurePanelOnDemandTls,
} from "../remote/index.ts";
import { log } from "./types.ts";

const TICK_MS = 30_000;
// `let` so tests can shrink the poll loop — see `_setTimingsForTest`.
let pollSnapshotMs = 5_000;
let snapshotTimeoutMs = 30 * 60_000;
// Provider snapshot quota safety margin. Hetzner default is ~100 per project;
// we refuse to start a freeze if we're already at or above this many managed
// snapshots so a wake-during-freeze (which briefly holds an extra slot) can't
// blow the cap. Configurable via `OCD_SNAPSHOT_QUOTA_LIMIT` for providers
// with different defaults. Counted against panel-managed snapshots only.
let snapshotQuotaLimit = Number(process.env.OCD_SNAPSHOT_QUOTA_LIMIT ?? 95);

type FreezeCtx = {
  jobId: number;
  serverId: number;
  /** Set to true by `cancelFreezeForServer`. Checked at every step. */
  cancelled: boolean;
  /** Resolves when `runFreezeJob` has fully unwound (success, fail, or
   *  cancel). Wake.ts awaits this before proceeding. */
  done: Promise<void>;
};

const activeCtx = new Map<number, FreezeCtx>(); // key = serverId

let timer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

/**
 * Mark the active freeze job for a server as cancelled and wait until the
 * worker has cleaned up any in-flight snapshot. If there's no active job,
 * returns immediately. Safe to call even if the server is not currently
 * freezing.
 */
export async function cancelFreezeForServer(serverId: number): Promise<void> {
  const ctx = activeCtx.get(serverId);
  if (!ctx) return;
  log("freeze", `cancelling job ${ctx.jobId} for server ${serverId}`);
  ctx.cancelled = true;
  await ctx.done;
}

/** Returns true iff a freeze job is currently running for this server. */
export function isFreezeActive(serverId: number): boolean {
  return activeCtx.has(serverId);
}

async function runFreezeJob(jobId: number): Promise<void> {
  const job = db.getFreezeJob(jobId);
  if (!job) return;
  // Terminal states — nothing to do
  if (job.state === "done" || job.state === "cancelled" || job.state === "failed") return;
  if (activeCtx.has(job.server_id)) return; // already running

  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });
  const ctx: FreezeCtx = {
    jobId,
    serverId: job.server_id,
    cancelled: false,
    done,
  };
  activeCtx.set(job.server_id, ctx);

  try {
    await doFreeze(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("freeze", `job ${jobId} errored: ${msg}`);
    try {
      db.updateFreezeJobState(jobId, "failed", { error: msg });
      db.setFreezeFailed(ctx.serverId);
    } catch (inner) {
      log("freeze", `failed to mark job ${jobId} failed: ${inner}`);
    }
  } finally {
    activeCtx.delete(ctx.serverId);
    resolveDone();
  }
}

async function doFreeze(ctx: FreezeCtx): Promise<void> {
  const { jobId, serverId } = ctx;

  const server = db.getServer(serverId);
  if (!server) {
    db.updateFreezeJobState(jobId, "cancelled", { error: "server row missing" });
    return;
  }
  if (server.state === "frozen") {
    // Already frozen — nothing to do (probably a stale pending job).
    db.updateFreezeJobState(jobId, "done");
    return;
  }

  // Panel's own server must never freeze.
  const panel = db.getPanel();
  if (panel?.server_id === serverId) {
    db.updateFreezeJobState(jobId, "cancelled", { error: "panel server cannot be frozen" });
    return;
  }

  // Still freeze-eligible? A wake may have raced in between enqueue and now.
  if (db.hasRunningReplicas(serverId)) {
    db.updateFreezeJobState(jobId, "cancelled", {
      error: "server has running replicas",
    });
    return;
  }

  const compute = getComputeProvider(server.provider);
  if (!compute.snapshots) {
    db.updateFreezeJobState(jobId, "failed", {
      error: `provider ${server.provider} does not support snapshots`,
    });
    db.setFreezeFailed(serverId);
    return;
  }

  if (ctx.cancelled) {
    db.updateFreezeJobState(jobId, "cancelled");
    return;
  }

  // Gather volume metadata for every app that keeps state on this server.
  // `getApps(serverId)` joins through replicas — stopped anchors still count,
  // which is exactly what we want here.
  const apps = db.getApps(serverId);

  // Eligibility gate: every app on this server must be deep-freeze-able.
  // An app is freeze-eligible iff its wake page can live on the panel
  // (real public domain — not nip.io or .localhost) AND we own DNS records
  // we can swap to the panel IP. Apps without those preconditions can't go
  // through the panel-hosted wake page flow, and freezing the server would
  // strand them on a destroyed IP. Refuse the freeze and stay in light
  // sleep — this is fail-closed by design, the operator has to either give
  // the app a managed domain or accept that it never deep-sleeps.
  //
  // Done BEFORE umount/snapshot so an ineligible app costs zero provider I/O.
  const ineligible: { app: db.AppRow; reason: string }[] = [];
  for (const app of apps) {
    const reason = freezeIneligibleReason(app);
    if (reason) ineligible.push({ app, reason });
  }
  if (ineligible.length > 0) {
    const detail = ineligible
      .map(({ app, reason }) => `${app.domain || app.name}: ${reason}`)
      .join("; ");
    log(
      "freeze",
      `job ${jobId}: refusing to freeze server ${serverId} — ${detail}`,
    );
    db.updateFreezeJobState(jobId, "failed", {
      error: `cannot deep-freeze: ${detail}`,
    });
    db.setFreezeFailed(serverId);
    return;
  }

  const volumeIds: string[] = [];
  const volumeMountPaths: string[] = [];
  for (const app of apps) {
    if (app.volume_id) volumeIds.push(app.volume_id);
    if (app.volume_mount) {
      const hostPath = app.volume_mount.split(":")[0];
      if (hostPath) volumeMountPaths.push(hostPath);
    }
  }

  // 1. Umount any cloud volume mount points inside the OS so the snapshot
  //    captures a clean FS. Containers are already stopped — that's a
  //    prerequisite established by scale-down in Phase 0.
  const hostKey = server.ssh_host_key || undefined;
  for (const mountPath of volumeMountPaths) {
    try {
      // `|| true` so a path that isn't actually mounted (e.g. after a reboot
      // where automount didn't run) doesn't abort the freeze.
      await sshExec(
        server.ipv4,
        `umount ${mountPath} 2>/dev/null || true`,
        hostKey,
      );
    } catch (err) {
      log("freeze", `umount ${mountPath} failed (continuing): ${err}`);
    }
  }

  if (ctx.cancelled) {
    db.updateFreezeJobState(jobId, "cancelled");
    return;
  }

  // 2. Issue (or resume) snapshot creation. After a panel restart, the job
  //    row's snapshot_id may already be set from a prior `snapshotting`
  //    attempt — in that case we re-attach to the existing snapshot rather
  //    than leaking it (and burning an extra Hetzner quota slot) by issuing
  //    a fresh create. Re-fetched here so we see writes from any previous
  //    worker run that crashed mid-flight.
  const persistedJob = db.getFreezeJob(jobId);
  const priorSnapshotId = persistedJob?.snapshot_id || "";
  let snapshotId = "";
  let resumedSnapshot = false;

  if (priorSnapshotId) {
    try {
      const info = await compute.snapshots.get(priorSnapshotId);
      if (info.status === "available" || info.status === "creating") {
        snapshotId = priorSnapshotId;
        resumedSnapshot = true;
        log(
          "freeze",
          `job ${jobId}: resuming with existing snapshot ${snapshotId} (status=${info.status})`,
        );
      } else {
        log(
          "freeze",
          `job ${jobId}: prior snapshot ${priorSnapshotId} status=${info.status}, will create fresh`,
        );
      }
    } catch (err) {
      log(
        "freeze",
        `job ${jobId}: prior snapshot ${priorSnapshotId} not retrievable (${err}), will create fresh`,
      );
    }
    if (!snapshotId) {
      // Stale id — clear it before issuing a new create so a partial failure
      // doesn't leave us pointing at a dead snapshot. Best-effort delete in
      // case the provider still has it under another status.
      try {
        await compute.snapshots.delete(priorSnapshotId);
      } catch {
        /* best-effort */
      }
      db.updateFreezeJobState(jobId, "snapshotting", { snapshot_id: "" });
    }
  }

  // 1b. Snapshot quota guard. If the provider is already at (or past) our
  //     configured limit, refuse to start — this would otherwise blow the
  //     Hetzner ~100/project cap, especially given wake-during-freeze can
  //     briefly hold an extra slot. The server stays materialized so it
  //     keeps serving traffic; on the next idle cycle freezeServerIfEmpty
  //     will re-enqueue. The user-visible effect is: the app lives in
  //     light sleep forever until some other server's snapshot is released.
  //
  //     Skipped on resume — we already hold our slot.
  if (!resumedSnapshot && compute.snapshots.list) {
    try {
      const snapshots = await compute.snapshots.list();
      if (snapshots.length >= snapshotQuotaLimit) {
        log(
          "freeze",
          `job ${jobId}: snapshot quota at ${snapshots.length}/${snapshotQuotaLimit} — staying in light sleep`,
        );
        db.updateFreezeJobState(jobId, "failed", {
          error: `snapshot quota reached (${snapshots.length}/${snapshotQuotaLimit})`,
        });
        db.setFreezeFailed(serverId);
        return;
      }
    } catch (err) {
      // Listing failed — degrade to a warning and proceed. A provider that
      // can't count snapshots is less bad than a freeze that refuses to run.
      log("freeze", `snapshot quota check failed (continuing): ${err}`);
    }
  }

  // Past this point cancellation means "let the image finish then delete it"
  // — Hetzner does not expose mid-flight image cancellation.
  if (!snapshotId) {
    db.updateFreezeJobState(jobId, "snapshotting");
    const description = `ocd-freeze-${server.name}-${Date.now()}`;
    try {
      const created = await compute.snapshots.create(
        server.provider_id,
        description,
      );
      snapshotId = created.snapshotId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.updateFreezeJobState(jobId, "failed", { error: `snapshot create: ${msg}` });
      db.setFreezeFailed(serverId);
      return;
    }
    db.updateFreezeJobState(jobId, "snapshotting", { snapshot_id: snapshotId });
    log("freeze", `job ${jobId}: snapshot ${snapshotId} creating for server ${serverId}`);
  }

  // 3. Poll until the snapshot is available or fails.
  const pollStart = Date.now();
  let snapshotReady = false;
  while (!snapshotReady) {
    await Bun.sleep(pollSnapshotMs);
    try {
      const info = await compute.snapshots.get(snapshotId);
      if (info.status === "available") {
        snapshotReady = true;
        break;
      }
      if (info.status === "failed") {
        db.updateFreezeJobState(jobId, "failed", {
          error: "snapshot build failed",
        });
        db.setFreezeFailed(serverId);
        // Don't leave a zombie image behind
        try {
          await compute.snapshots.delete(snapshotId);
        } catch {
          /* best-effort */
        }
        return;
      }
    } catch (err) {
      log("freeze", `snapshot poll error (continuing): ${err}`);
    }
    if (Date.now() - pollStart > snapshotTimeoutMs) {
      db.updateFreezeJobState(jobId, "failed", { error: "snapshot poll timeout" });
      db.setFreezeFailed(serverId);
      try {
        await compute.snapshots.delete(snapshotId);
      } catch {
        /* best-effort */
      }
      return;
    }
  }

  // 4. Honor cancellation before we take any destructive action. Past this
  //    check, the finalization step is atomic-ish — it can still fail on the
  //    provider side, but we won't abort voluntarily.
  if (ctx.cancelled) {
    log("freeze", `job ${jobId}: cancelled after snapshot available — deleting snapshot`);
    try {
      await compute.snapshots.delete(snapshotId);
    } catch (err) {
      log("freeze", `snapshot delete on cancel failed: ${err}`);
    }
    db.updateFreezeJobState(jobId, "cancelled");
    return;
  }

  // 4b. Phase 5 handoff — move each app's wake page from the tenant server
  //     onto the panel server, and swap DNS to point at the panel IP. This
  //     must happen BEFORE we destroy the instance: at every point in time
  //     the app's DNS name must resolve to a server that can answer with a
  //     wake page, otherwise a request mid-freeze would see a dead host.
  //
  //     If the panel server isn't reachable / the panel row is missing /
  //     the provider doesn't support on-demand TLS gracefully, we keep the
  //     app on light sleep and fail the freeze job with a specific error.
  //     The server row stays materialized so the next freeze cycle retries.
  const handoff = await handOffWakePagesToPanel(serverId, apps);
  if (!handoff.ok) {
    db.updateFreezeJobState(jobId, "failed", {
      error: `panel wake handoff: ${handoff.error}`,
    });
    db.setFreezeFailed(serverId);
    // Orphan cleanup — the snapshot is no use to us if we can't finish
    // the freeze.
    try {
      await compute.snapshots.delete(snapshotId);
    } catch (inner) {
      log("freeze", `orphan snapshot cleanup failed: ${inner}`);
    }
    return;
  }

  // 5. Finalize: detach volumes, destroy the instance, mark the server row.
  db.updateFreezeJobState(jobId, "finalizing");
  log("freeze", `job ${jobId}: finalizing server ${serverId}`);

  try {
    if (compute.volumes && volumeIds.length > 0) {
      for (const volumeId of volumeIds) {
        try {
          await compute.volumes.detach(volumeId);
        } catch (err) {
          log("freeze", `detach volume ${volumeId} failed (continuing): ${err}`);
        }
      }
    }

    if (server.provider_id) {
      await compute.deleteServer(server.provider_id);
    }
  } catch (err) {
    // Partial failure during finalization. Leave the job failed; next
    // freeze attempt (1h backoff) will try again. The server row is not
    // marked frozen because we can't guarantee the instance is actually
    // destroyed.
    const msg = err instanceof Error ? err.message : String(err);
    db.updateFreezeJobState(jobId, "failed", { error: `finalize: ${msg}` });
    db.setFreezeFailed(serverId);
    // The snapshot is now orphaned — delete it so we don't leak quota.
    try {
      await compute.snapshots.delete(snapshotId);
    } catch (inner) {
      log("freeze", `orphan snapshot cleanup failed: ${inner}`);
    }
    return;
  }

  // 6. Update the server row — this is the atomic "server is now frozen"
  //    commit point. After this, wake must go through the Phase 4 deep path.
  db.markServerFrozen(serverId, {
    snapshot_id: snapshotId,
    volume_ids: volumeIds,
  });
  db.updateFreezeJobState(jobId, "done");
  log("freeze", `job ${jobId}: server ${serverId} frozen (snapshot=${snapshotId})`);
}

async function tick(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const jobs = db.listActiveFreezeJobs();
    for (const job of jobs) {
      if (activeCtx.has(job.server_id)) continue;
      // Fire and forget — runFreezeJob manages its own ctx lifetime.
      void runFreezeJob(job.id);
    }
  } catch (err) {
    log("freeze", `tick error: ${err}`);
  } finally {
    tickRunning = false;
  }
}

export function startFreezeWorker(): void {
  if (timer) return;
  log("freeze", `freeze worker starting (tick=${TICK_MS}ms)`);
  // Delay first tick so server finishes booting.
  setTimeout(() => {
    void tick();
  }, 10_000);
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
}

export function stopFreezeWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Test-only entry point. Runs a freeze job to completion (or failure) in the
 * current task so tests can await the full state transition without waiting
 * for a tick. Not part of the public worker API.
 */
export async function _runFreezeJobForTest(jobId: number): Promise<void> {
  await runFreezeJob(jobId);
}

/** Test-only: override the polling intervals so tests don't wait 5s per poll. */
export function _setTimingsForTest(opts: {
  pollMs?: number;
  timeoutMs?: number;
  quotaLimit?: number;
}): void {
  if (opts.pollMs !== undefined) pollSnapshotMs = opts.pollMs;
  if (opts.timeoutMs !== undefined) snapshotTimeoutMs = opts.timeoutMs;
  if (opts.quotaLimit !== undefined) snapshotQuotaLimit = opts.quotaLimit;
}

/** Test-only: start a freeze job asynchronously without awaiting completion.
 *  Returns the ctx Promise so tests can await final state. */
export function _startFreezeJobForTest(jobId: number): Promise<void> {
  return runFreezeJob(jobId);
}

/**
 * Returns a human-readable reason if this app cannot participate in the
 * panel-hosted-wake-page deep-freeze flow, or null if it's eligible. The
 * freeze worker uses this as a fail-closed gate: even one ineligible app
 * on a server blocks the entire freeze, because freezing would destroy the
 * tenant instance and leave that app's domain pointing at a dead IP.
 *
 * Ineligible cases:
 *   - no domain at all (raw-IP-only app)
 *   - .nip.io / .localhost (the panel's on-demand TLS ask endpoint refuses
 *     these — Caddy can't mint a public cert for them, so the wake page
 *     would fail TLS handshake on the panel)
 *   - no managed DNS A records — DNS swap to the panel IP isn't possible
 *     because we don't own the zone for this domain
 */
function freezeIneligibleReason(app: db.AppRow): string | null {
  if (!app.domain) return "no domain configured (raw IP)";
  if (app.domain.endsWith(".nip.io")) {
    return "nip.io domain cannot be hosted on the panel";
  }
  if (app.domain.endsWith(".localhost")) {
    return ".localhost domain cannot be hosted on the panel";
  }
  const records = db.getDnsRecords(app.id).filter((r) => r.type === "A");
  if (records.length === 0) {
    return "no managed DNS A records (cannot swap to panel IP)";
  }
  return null;
}

/**
 * Move every app on the given server from "wake page on the tenant server"
 * (light sleep anchor) to "wake page on the panel server" (the Phase 5
 * state). Returns `{ ok: false, error }` on failure — the caller rolls back
 * by leaving the server materialized.
 *
 * This is the gatekeeper for the freeze flow: if we can't get DNS pointed at
 * the panel and the wake page installed there, we refuse to destroy the
 * instance, because doing so would mean requests for the app's domain land
 * on a dead IP until the next idle cycle retries.
 */
async function handOffWakePagesToPanel(
  serverId: number,
  apps: ReturnType<typeof db.getApps>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (apps.length === 0) return { ok: true }; // no-op, nothing to migrate

  const panel = db.getPanel();
  if (!panel) {
    return { ok: false, error: "no panel configured" };
  }
  const panelServer = db.getServer(panel.server_id);
  if (!panelServer) {
    return { ok: false, error: "panel server row missing" };
  }
  if (!panelServer.ipv4) {
    return { ok: false, error: "panel server has no ipv4" };
  }
  if (!panel.domain) {
    return { ok: false, error: "panel has no domain configured" };
  }

  const panelHostKey = panelServer.ssh_host_key || undefined;

  // 1. Bootstrap on-demand-TLS on the panel. Idempotent — safe even if a
  //    previous freeze already enabled it.
  try {
    await ensurePanelOnDemandTls(panelServer.ipv4, panel.domain, panelHostKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `on-demand TLS setup: ${msg}` };
  }

  const dns = getDnsProvider();

  for (const app of apps) {
    log("freeze", `panel-handoff: migrating ${app.domain} → ${panelServer.ipv4} (server ${serverId})`);

    // Every sleeping app must have a wake_token set by scale-down. Fall back
    // to a fresh one if it's missing somehow — better a working wake page
    // than a broken one.
    let wakeToken = app.wake_token || "";
    if (!wakeToken) {
      wakeToken = crypto.randomUUID();
      db.updateAppSleepingState(
        app.id,
        serverId,
        app.sleeping_host_port ?? 0,
        wakeToken,
      );
    }

    // 2. Install the wake page on the panel's Caddy. On-demand TLS handles
    //    cert minting when the first real request comes in.
    try {
      await deployPanelWakePage(
        panelServer.ipv4,
        panel.domain,
        app.domain,
        app.id,
        wakeToken,
        panelHostKey,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `deploy panel wake page for ${app.domain}: ${msg}` };
    }

    // 3. Swap DNS create-then-delete so there's never a window with no
    //    A record. Nip.io / .localhost domains are no-ops for DNS anyway.
    try {
      await swapDnsToPanelIp(app.id, app.domain, panelServer.ipv4, dns);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("freeze", `DNS swap to panel for ${app.domain} failed (continuing): ${msg}`);
      // DNS swap failure isn't fatal — the wake page is installed, and the
      // ask endpoint will authorize cert minting on the next propagation.
      // Worst case the user manually updates DNS. We still flip the flag.
    }

    // 4. Flip the flag so the ask endpoint begins authorizing cert minting
    //    for this domain. Set this AFTER the route is installed so we
    //    don't briefly authorize a domain that has nowhere to land.
    db.setAppWakePageOnPanel(app.id, true);
  }

  return { ok: true };
}

/**
 * Point all A records for `appDomain` at the panel IP. Uses the same
 * create-new → delete-old pattern as wake.ts so the name is never without
 * an A record. Throws on the create leg so the caller can decide whether
 * to treat it as fatal; the delete leg is best-effort.
 */
async function swapDnsToPanelIp(
  appId: number,
  appDomain: string,
  panelIpv4: string,
  dns: ReturnType<typeof getDnsProvider>,
): Promise<void> {
  const records = db.getDnsRecords(appId).filter((r) => r.type === "A");
  if (records.length === 0) {
    // No DNS records tracked (e.g. nip.io apps) — the domain resolves to
    // something we don't manage, so there's nothing to swap. Still fine
    // from the handoff's POV.
    return;
  }
  for (const record of records) {
    if (record.value === panelIpv4) continue;
    const created = await dns.createRecord({
      zoneId: record.zone_id,
      name: record.name,
      type: "A",
      value: panelIpv4,
    });
    db.insertDnsRecord({
      app_id: appId,
      zone_id: record.zone_id,
      record_id: created.id,
      name: record.name,
      type: "A",
      value: panelIpv4,
    });
    try {
      await dns.deleteRecord({
        zoneId: record.zone_id,
        name: record.name,
        type: "A",
        value: record.value,
      });
    } catch (err) {
      log("freeze", `DNS old record delete failed (continuing): ${err}`);
    }
    db.deleteDnsRecord(record.record_id);
    log("freeze", `DNS swapped to panel: ${appDomain} -> ${panelIpv4}`);
  }
}
