#!/usr/bin/env bun
//
// migrate-volume-bind-mounts.ts — repair the historical Hetzner-volume
// bind-mount bug.
//
// Background: apps/services with a persistent Hetzner volume reference
// `/mnt/ocd-${name}-data`, but Hetzner's automount lands the real device at
// `/mnt/HC_Volume_${id}`. Without an explicit bind, Docker has been writing
// to the root filesystem the whole time. This script:
//
//   1. For every app/service with a `volume_id`, on a Hetzner server, finds
//      the source data on the root filesystem (the legacy path) and rsyncs
//      it onto the real volume.
//   2. Renames the legacy path to a timestamped `.preflip` directory.
//   3. Sets up the bind mount via the shared `ensureVolumeBindMount` helper.
//   4. Restarts the container and smoke-probes that data is visible inside.
//   5. On any post-rsync failure, auto-rolls back (umount, restore preflip,
//      restart).
//
// Defaults to dry-run-ish behavior for collision-prone steps; the most useful
// invocations are:
//
//   bun scripts/migrate-volume-bind-mounts.ts --dry-run
//   bun scripts/migrate-volume-bind-mounts.ts --app some-app
//   bun scripts/migrate-volume-bind-mounts.ts --cleanup-stale-fstab
//   bun scripts/migrate-volume-bind-mounts.ts --cleanup-stale-fstab --apply
//
// State is persisted to ${DATA_DIR}/migrate-volumes/state.json so a partial
// run can resume.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import "../src/shared/providers/index.ts"; // register compute providers
import { getComputeProvider } from "../src/shared/providers/index.ts";
import db from "../src/shared/db.ts";
import * as dbApi from "../src/shared/db.ts";
import { sshExec } from "../src/engine/hetzner/ssh.ts";
import {
  ensureVolumeBindMount,
  removeVolumeBindMount,
  bindMountStatus,
} from "../src/engine/hetzner/host-mounts.ts";
import { DATA_DIR } from "../src/shared/paths.ts";

type Argv = {
  dryRun: boolean;
  app: string | null;
  resume: boolean;
  forceOverwrite: boolean;
  sizeTolerancePct: number;
  cleanupStaleFstab: boolean;
  apply: boolean;
};

function parseArgs(): Argv {
  const a: Argv = {
    dryRun: false,
    app: null,
    resume: false,
    forceOverwrite: false,
    sizeTolerancePct: 1,
    cleanupStaleFstab: false,
    apply: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--dry-run") a.dryRun = true;
    else if (x === "--resume") a.resume = true;
    else if (x === "--force-overwrite") a.forceOverwrite = true;
    else if (x === "--cleanup-stale-fstab") a.cleanupStaleFstab = true;
    else if (x === "--apply") a.apply = true;
    else if (x === "--app") a.app = argv[++i];
    else if (x === "--size-tolerance-pct") a.sizeTolerancePct = Number(argv[++i]);
    else if (x === "-h" || x === "--help") {
      console.log(`Usage: bun scripts/migrate-volume-bind-mounts.ts [opts]
  --dry-run              Plan only, no mutations.
  --app <name>           Restrict to a single app or service (preferred for first runs).
  --resume               Re-run all items; idempotency probes skip done work.
  --force-overwrite      Overwrite volume even when its data is non-empty.
  --size-tolerance-pct N Acceptable size delta % after rsync (default 1).
  --cleanup-stale-fstab  List orphaned /mnt/HC_Volume_* fstab entries on all servers.
  --apply                Combined with --cleanup-stale-fstab: actually mutate.
`);
      process.exit(0);
    }
  }
  return a;
}

const opts = parseArgs();

const STATE_DIR = path.join(DATA_DIR, "migrate-volumes");
const STATE_FILE = path.join(STATE_DIR, "state.json");
mkdirSync(STATE_DIR, { recursive: true });

type ItemKey = string; // "app:42" | "svc:7"
type ItemStatus = "pending" | "in-progress" | "done" | "skipped" | "error";
type ItemState = {
  status: ItemStatus;
  lastStep: string;
  errorMsg?: string;
  preflipPath?: string;
};
type StateFile = { items: Record<ItemKey, ItemState> };

function loadState(): StateFile {
  if (!existsSync(STATE_FILE)) return { items: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { items: {} };
  }
}
function saveState(s: StateFile) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
let state = loadState();

function setItem(key: ItemKey, patch: Partial<ItemState>) {
  const prev = state.items[key] || { status: "pending" as ItemStatus, lastStep: "init" };
  state.items[key] = { ...prev, ...patch };
  saveState(state);
}

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

type Item = {
  kind: "app" | "svc";
  key: ItemKey;
  id: number;
  name: string;
  volumeId: string;
  volumeMount: string;
  containerPath: string;
  containerName: string; // for app: app.name; for svc: instance.container_name
  hostPath: string;      // /mnt/ocd-${name}-data or /mnt/ocd-svc-${name}-data
  serverIpv4: string | null;
  serverHostKey: string | null;
  blockName: string;     // app-${id} | svc-${id}
  deployMode?: "dockerfile" | "compose";
};

function collectItems(): Item[] {
  const out: Item[] = [];
  const apps = (dbApi as any).getApps ? (dbApi as any).getApps() : [];
  for (const app of apps) {
    if (!app.volume_id) continue;
    const reps = (dbApi as any).getReplicas(app.id) || [];
    const server = reps[0] ? (dbApi as any).getServer(reps[0].server_id) : null;
    const mountParts = (app.volume_mount || "").split(":");
    const hostPath = mountParts[0] || `/mnt/ocd-${app.name}-data`;
    const containerPath = mountParts[1] || "/data";
    out.push({
      kind: "app",
      key: `app:${app.id}`,
      id: app.id,
      name: app.name,
      volumeId: app.volume_id,
      volumeMount: app.volume_mount,
      containerPath,
      containerName: app.name,
      hostPath,
      serverIpv4: server?.ipv4 || null,
      serverHostKey: server?.ssh_host_key || null,
      blockName: `app-${app.id}`,
      deployMode: app.deploy_mode || "dockerfile",
    });
  }
  const services = (dbApi as any).getServices ? (dbApi as any).getServices() : [];
  for (const svc of services) {
    const instances = (dbApi as any).getServiceInstances(svc.id) || [];
    const primary = instances.find((i: any) => i.role === "primary") || instances[0];
    if (!primary || !primary.volume_id) continue;
    const server = (dbApi as any).getServer(primary.server_id);
    const mountParts = (primary.volume_mount || "").split(":");
    const hostPath = mountParts[0] || `/mnt/ocd-svc-${svc.name}-data`;
    const containerPath = mountParts[1] || "/data";
    out.push({
      kind: "svc",
      key: `svc:${svc.id}`,
      id: svc.id,
      name: svc.name,
      volumeId: primary.volume_id,
      volumeMount: primary.volume_mount,
      containerPath,
      containerName: primary.container_name,
      hostPath,
      serverIpv4: server?.ipv4 || null,
      serverHostKey: server?.ssh_host_key || null,
      blockName: `svc-${svc.id}`,
    });
  }
  return out;
}

function tsStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function ssh(item: Item, cmd: string) {
  if (!item.serverIpv4) throw new Error(`item ${item.key} has no server`);
  return sshExec(item.serverIpv4, cmd, item.serverHostKey || undefined);
}

async function probeVolumeNonEmpty(item: Item): Promise<{ nonEmpty: boolean; newestMtime: number }> {
  const hc = `/mnt/HC_Volume_${item.volumeId}`;
  const out = await ssh(
    item,
    `find ${hc} -mindepth 1 -maxdepth 1 ! -name lost+found 2>/dev/null | head -1; echo '---'; find ${hc} -type f ! -path '*/lost+found/*' -printf '%T@\\n' 2>/dev/null | sort -n | tail -1`,
  );
  const lines = out.stdout.split("---");
  const top = (lines[0] || "").trim();
  const mtime = Number(((lines[1] || "").trim()) || 0);
  return { nonEmpty: top.length > 0, newestMtime: mtime };
}

async function probeSourceMtime(item: Item): Promise<number> {
  const out = await ssh(
    item,
    `find ${item.hostPath} -type f -printf '%T@\\n' 2>/dev/null | sort -n | tail -1`,
  );
  return Number((out.stdout.trim()) || 0);
}

async function duBytes(item: Item, p: string): Promise<number> {
  const out = await ssh(item, `du -sb ${p} 2>/dev/null | awk '{print $1}'`);
  return Number(out.stdout.trim() || 0);
}

async function stopContainer(item: Item) {
  const asUser = (c: string) => `su - deploy -c ${JSON.stringify(c)}`;
  if (item.kind === "app" && item.deployMode === "compose" && item.containerName === item.name) {
    await ssh(item, asUser(`cd /home/deploy/apps/${item.name} && docker compose down -t 20 2>/dev/null || true`));
  } else {
    await ssh(item, asUser(`docker stop -t 20 ${item.containerName} 2>/dev/null || true`));
    await ssh(item, asUser(`docker rm -f ${item.containerName} 2>/dev/null || true`));
  }
}

async function startContainer(item: Item) {
  // App: defer to recreateAppContainer for richest behavior. Service: re-run
  // the catalog deploy is overkill — do `docker start` and rely on the
  // container's restart policy. Best-effort.
  const asUser = (c: string) => `su - deploy -c ${JSON.stringify(c)}`;
  if (item.kind === "app") {
    try {
      const { recreateAppContainer } = await import("../src/engine/deploy/lifecycle.ts");
      const app = (dbApi as any).getApp(item.id);
      let extras: string[] = [];
      if (app?.extra_volumes) {
        try { const a = JSON.parse(app.extra_volumes); if (Array.isArray(a)) extras = a; }
        catch { /* ignore */ }
      }
      const r = await recreateAppContainer(item.id, item.volumeMount || `${item.hostPath}:${item.containerPath}`, extras);
      if (!r.ok) throw new Error(r.error || "recreateAppContainer failed");
      return;
    } catch (err) {
      log(`recreateAppContainer failed (${item.key}), falling back to docker start: ${err}`);
    }
  }
  await ssh(item, asUser(`docker start ${item.containerName} 2>&1 || true`));
}

async function smokeProbe(item: Item, expectData: boolean): Promise<boolean> {
  const asUser = (c: string) => `su - deploy -c ${JSON.stringify(c)}`;
  const r = await ssh(item, asUser(`docker exec ${item.containerName} ls ${item.containerPath} 2>/dev/null || true`));
  const entries = r.stdout.trim().split(/\s+/).filter(Boolean);
  if (expectData && entries.length === 0) return false;
  return true;
}

async function rollback(item: Item, preflipPath: string) {
  log(`[${item.key}] ROLLBACK: umount + restore preflip + restart`);
  try {
    await removeVolumeBindMount({
      serverIp: item.serverIpv4!,
      hostKey: item.serverHostKey || undefined,
      hostMountPath: item.hostPath,
      blockName: item.blockName,
    });
  } catch (err) { log(`[${item.key}] rollback umount failed: ${err}`); }
  try {
    // Restore preflip back to original path.
    await ssh(item, `rm -rf ${item.hostPath} 2>/dev/null; mv ${preflipPath} ${item.hostPath}`);
  } catch (err) { log(`[${item.key}] rollback rename failed: ${err}`); }
  try { await startContainer(item); }
  catch (err) { log(`[${item.key}] rollback restart failed: ${err}`); }
}

async function migrateOne(item: Item): Promise<void> {
  const key = item.key;
  const log0 = (msg: string) => log(`[${key} ${item.name}]`, msg);

  // 1. Resolve server.
  if (!item.serverIpv4) {
    log0("skipped: no-replicas");
    setItem(key, { status: "skipped", lastStep: "resolve-server", errorMsg: "no replicas / no server" });
    return;
  }

  // 2. Duplicate volume_id check.
  const all = collectItems();
  const dups = all.filter((x) => x.volumeId === item.volumeId && x.key !== item.key);
  if (dups.length > 0) {
    const names = dups.map((d) => `${d.key} (${d.name})`).join(", ");
    log0(`ERROR duplicate-volume-id with: ${names}`);
    setItem(key, { status: "error", lastStep: "dup-check", errorMsg: `duplicate volume_id with ${names}` });
    return;
  }

  // 3. Provider gate.
  let providerId: string;
  try {
    providerId = getComputeProvider().id;
  } catch (err) {
    log0(`ERROR no provider: ${err}`);
    setItem(key, { status: "error", lastStep: "provider", errorMsg: String(err) });
    return;
  }
  if (providerId !== "hetzner") {
    log0(`skipped: provider-${providerId}`);
    setItem(key, { status: "skipped", lastStep: "provider-gate" });
    return;
  }

  // 4. Verify Hetzner mount path is live.
  const hc = `/mnt/HC_Volume_${item.volumeId}`;
  const mounted = await ssh(item, `findmnt -no SOURCE ${hc} || true`);
  if (!mounted.stdout.trim()) {
    log0(`ERROR Hetzner volume not mounted at ${hc}`);
    setItem(key, { status: "error", lastStep: "verify-mount", errorMsg: `volume ${item.volumeId} not mounted at ${hc}` });
    return;
  }

  // Idempotency: bind already in place? Then this app is already migrated.
  const status = await bindMountStatus({
    serverIp: item.serverIpv4,
    hostKey: item.serverHostKey || undefined,
    hostMountPath: item.hostPath,
  });
  if (status.sourceDevice === hc) {
    log0("already migrated (bind in place)");
    setItem(key, { status: "done", lastStep: "already-bound" });
    return;
  }

  // 5. Collision check.
  const volProbe = await probeVolumeNonEmpty(item);
  if (volProbe.nonEmpty) {
    const srcMtime = await probeSourceMtime(item);
    if (volProbe.newestMtime > srcMtime) {
      log0(`ERROR volume-has-newer-data (volume mtime=${volProbe.newestMtime} src mtime=${srcMtime})`);
      setItem(key, { status: "error", lastStep: "collision", errorMsg: "volume has newer data than source" });
      return;
    }
    if (!opts.forceOverwrite) {
      log0(`ERROR volume non-empty; pass --force-overwrite to proceed`);
      setItem(key, { status: "error", lastStep: "collision", errorMsg: "volume non-empty (no --force-overwrite)" });
      return;
    }
  }

  if (opts.dryRun) {
    log0("dry-run PLAN: stop, rsync, preflip, bind, restart");
    setItem(key, { status: "pending", lastStep: "dry-run-plan" });
    return;
  }

  setItem(key, { status: "in-progress", lastStep: "start" });

  // 6. Stop container.
  log0("step: stop container");
  await stopContainer(item);
  setItem(key, { status: "in-progress", lastStep: "stopped" });

  // 7. rsync from legacy → volume.
  log0(`step: rsync ${item.hostPath}/ -> ${hc}/`);
  const rsyncResult = await ssh(
    item,
    `rsync -aHAX --numeric-ids --info=stats2 ${item.hostPath}/ ${hc}/`,
  );
  log0(`rsync stdout:\n${rsyncResult.stdout}`);
  if (rsyncResult.exitCode !== 0) {
    log0(`rsync FAILED (exit ${rsyncResult.exitCode}): ${rsyncResult.stderr}`);
    setItem(key, { status: "error", lastStep: "rsync", errorMsg: rsyncResult.stderr });
    return;
  }

  // 8. Size verification.
  const srcSize = await duBytes(item, item.hostPath);
  const dstSize = await duBytes(item, hc);
  const delta = srcSize === 0 ? 0 : Math.abs(srcSize - dstSize) / srcSize * 100;
  log0(`size check: src=${srcSize} dst=${dstSize} delta=${delta.toFixed(2)}%`);
  if (delta > opts.sizeTolerancePct) {
    log0(`ERROR size delta ${delta.toFixed(2)}% exceeds tolerance ${opts.sizeTolerancePct}%`);
    setItem(key, { status: "error", lastStep: "size-check", errorMsg: `size delta ${delta.toFixed(2)}%` });
    return;
  }

  // 9. Rename legacy path to .preflip.${ts}.
  const preflipPath = `${item.hostPath}.preflip.${tsStamp()}`;
  log0(`step: mv ${item.hostPath} -> ${preflipPath}`);
  const mv = await ssh(item, `mv ${item.hostPath} ${preflipPath}`);
  if (mv.exitCode !== 0) {
    log0(`mv FAILED: ${mv.stderr}`);
    setItem(key, { status: "error", lastStep: "preflip", errorMsg: mv.stderr });
    return;
  }
  setItem(key, { status: "in-progress", lastStep: "preflipped", preflipPath });

  // 10. Bind mount.
  log0(`step: ensureVolumeBindMount blockName=${item.blockName}`);
  try {
    await ensureVolumeBindMount({
      serverIp: item.serverIpv4,
      hostKey: item.serverHostKey || undefined,
      hetznerVolumeId: item.volumeId,
      hostMountPath: item.hostPath,
      blockName: item.blockName,
    });
  } catch (err) {
    log0(`ensureVolumeBindMount FAILED: ${err}`);
    await rollback(item, preflipPath);
    setItem(key, { status: "error", lastStep: "bind", errorMsg: String(err) });
    return;
  }

  // 11. Restart container.
  log0("step: restart container");
  try {
    await startContainer(item);
  } catch (err) {
    log0(`restart FAILED: ${err}`);
    await rollback(item, preflipPath);
    setItem(key, { status: "error", lastStep: "restart", errorMsg: String(err) });
    return;
  }

  // 12. Smoke probe.
  const expectData = srcSize > 0;
  const probe = await smokeProbe(item, expectData);
  if (!probe) {
    log0(`smoke probe FAILED — expected data inside container at ${item.containerPath}`);
    await rollback(item, preflipPath);
    setItem(key, { status: "error", lastStep: "smoke-probe", errorMsg: "no data visible in container" });
    return;
  }

  log0(`SUCCESS — preflip kept at ${preflipPath} (manual cleanup after 7 days)`);
  setItem(key, { status: "done", lastStep: "complete", preflipPath });
}

async function cleanupStaleFstab(): Promise<void> {
  // Walk all servers, list their /mnt/HC_Volume_* fstab entries, and figure
  // out which ones reference volumes that no longer exist (or aren't attached).
  const compute = getComputeProvider();
  if (compute.id !== "hetzner") {
    console.log("Cleanup only applies to Hetzner servers; provider is", compute.id);
    return;
  }
  if (!compute.volumes) {
    console.log("Provider has no volumes API");
    return;
  }
  const servers = (dbApi as any).getServers ? (dbApi as any).getServers() : [];
  const remoteVols = await compute.volumes.list();
  const volsById = new Map<string, { serverId: string | null }>();
  for (const v of remoteVols) volsById.set(v.providerId, { serverId: v.serverId });

  for (const srv of servers) {
    if (!srv.ipv4) continue;
    log(`server ${srv.name} (${srv.ipv4}): scanning fstab`);
    const grep = await sshExec(srv.ipv4, `grep -nE '/mnt/HC_Volume_[0-9]+' /etc/fstab 2>/dev/null || true`, srv.ssh_host_key || undefined);
    const lines = grep.stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      const m = line.match(/\/mnt\/HC_Volume_(\d+)/);
      if (!m) continue;
      const volId = m[1];
      const remote = volsById.get(volId);
      let reason: string | null = null;
      if (!remote) reason = "volume not in Hetzner panel";
      else if (remote.serverId !== srv.provider_id) reason = `volume attached to ${remote.serverId ?? "<detached>"}, not this server (${srv.provider_id})`;
      if (reason) {
        log(`  STALE: ${line.trim()}  -- ${reason}`);
        if (opts.apply) {
          const escaped = line.replace(/^\d+:/, "").replace(/'/g, "'\\''");
          await sshExec(
            srv.ipv4,
            `sed -i '\\#${escaped.split(/\s+/)[0].replace(/#/g, "\\#")}#d' /etc/fstab`,
            srv.ssh_host_key || undefined,
          );
          log(`  removed`);
        }
      }
    }
  }
  if (!opts.apply) console.log("(dry-run — re-run with --apply to remove the stale lines)");
}

async function main() {
  if (opts.cleanupStaleFstab) {
    await cleanupStaleFstab();
    return;
  }

  let items = collectItems();
  if (opts.app) items = items.filter((i) => i.name === opts.app);
  log(`migration plan: ${items.length} item(s)`);

  // Pre-emptive duplicate report.
  const byVol = new Map<string, Item[]>();
  for (const i of items) {
    const arr = byVol.get(i.volumeId) || [];
    arr.push(i);
    byVol.set(i.volumeId, arr);
  }
  for (const [vid, arr] of byVol) {
    if (arr.length > 1) {
      log(`duplicate volume_id ${vid}: ${arr.map((a) => a.key + "/" + a.name).join(", ")}`);
    }
  }

  for (const item of items) {
    const prior = state.items[item.key];
    if (prior?.status === "done" && !opts.resume) {
      log(`[${item.key}] already done — skipping (use --resume to re-check)`);
      continue;
    }
    try {
      await migrateOne(item);
    } catch (err) {
      log(`[${item.key}] UNCAUGHT: ${err}`);
      setItem(item.key, { status: "error", lastStep: "uncaught", errorMsg: String(err) });
    }
  }

  // Final report.
  const counts = { done: 0, skipped: 0, error: 0, pending: 0, "in-progress": 0 } as Record<string, number>;
  for (const v of Object.values(state.items)) counts[v.status] = (counts[v.status] || 0) + 1;
  log(`done. state: ${JSON.stringify(counts)}`);
  log(`state file: ${STATE_FILE}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
}).finally(() => {
  try { db.close(); } catch { /* ignore */ }
});
