import * as db from "../db.ts";
import { sshExec } from "../remote/index.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [caddy-legacy:${context}]`, ...args);
}

/**
 * Pre-migration route ids used by `deployCaddySite(...)`: `ocd-<domain>` with
 * dots replaced by dashes. The new panel Caddy uses `ocd-app-<name>` and
 * `ocd-internal-<name>` instead, so the legacies are safe to remove once DNS
 * swings to the panel — at that point no traffic can reach them anyway.
 */
function legacyRouteId(domain: string): string {
  return `ocd-${domain.replace(/\./g, "-")}`;
}

// Per-process dedupe set: once we've successfully issued the cleanup curls
// for (server, app), we skip it on every subsequent tick. This keeps the
// steady-state cost at exactly zero SSH calls without needing a DB column
// to track "have we cleaned this yet". If the process restarts we'll re-run
// the DELETEs once, which is a no-op on Caddy's side — the admin API
// returns success (via the `|| true`) whether or not the @id exists.
const cleaned = new Set<string>();

function cleanedKey(serverId: number, appId: number): string {
  return `${serverId}:${appId}`;
}

/**
 * Remove legacy `ocd-<domain-dashed>` routes left over from the per-tenant
 * Caddy ingress era. The panel Caddy is the only public ingress now, but the
 * old routes still live on:
 *
 *   - the panel server (for apps that were originally panel-hosted), and
 *   - every tenant server that still holds replicas for tracked apps.
 *
 * For each of those servers we hit Caddy's admin API on localhost:2019 and
 * DELETE by `@id` for every tracked app's legacy id. A missing id is not an
 * error (the `|| true` swallows it), so the pass is fully idempotent — the
 * first successful run wipes the legacies, subsequent runs are no-ops
 * because the in-memory dedupe set short-circuits.
 *
 * After mutating each server's live Caddy config we persist it to
 * `/etc/caddy/caddy.json` so a Caddy restart doesn't reload the legacies.
 */
export async function reconcileLegacyCaddyRoutes(): Promise<void> {
  const panel = db.getPanel();
  const panelServer = panel ? db.getServer(panel.server_id) : null;
  if (!panelServer || !panelServer.ipv4) {
    // Without a panel server we don't know which servers are in-scope and
    // can't talk to the panel Caddy either.
    return;
  }

  const apps = db.getApps();
  // Build the set of servers to visit: every tenant server that currently
  // holds a replica for any tracked app, plus the panel server itself.
  // Using a Map keyed by server id dedupes servers that host multiple apps
  // without losing the ServerRow we need for ssh (ipv4 + host key).
  const servers = new Map<number, db.ServerRow>();
  for (const app of apps) {
    for (const replica of db.getReplicas(app.id)) {
      if (servers.has(replica.server_id)) continue;
      const server = db.getServer(replica.server_id);
      if (!server || !server.ipv4) continue;
      if (server.state !== "materialized") continue; // frozen → no Caddy to talk to
      servers.set(server.id, server);
    }
  }
  // Always include the panel server — it owns the new ingress but may still
  // have legacies from when it hosted an app's own Caddy directly.
  if (panelServer.state === "materialized" && !servers.has(panelServer.id)) {
    servers.set(panelServer.id, panelServer);
  }

  if (apps.length === 0) return; // nothing to clean against

  for (const server of servers.values()) {
    // Collect the list of legacy ids to delete on THIS server that haven't
    // already been cleaned in a previous tick. We delete the id for every
    // tracked app regardless of whether this server currently hosts its
    // replica — a tenant server may still carry a dead route for an app
    // that was moved away, and the panel may carry one for an app that
    // was reassigned. Matching the task spec: "delete ocd-<appDomain-dashed>
    // directly — some tenant servers may have routes for apps that no
    // longer have replicas on them".
    const pending: Array<{ appId: number; id: string }> = [];
    for (const app of apps) {
      if (!app.domain) continue;
      const key = cleanedKey(server.id, app.id);
      if (cleaned.has(key)) continue;
      pending.push({ appId: app.id, id: legacyRouteId(app.domain) });
    }
    if (pending.length === 0) continue;

    // Chain the DELETEs into a single SSH invocation to avoid one
    // connection per app. Each DELETE is guarded with `|| true` so a
    // missing id doesn't short-circuit the rest of the batch.
    const deleteCmd = pending
      .map(
        (p) =>
          `curl -sf -X DELETE http://localhost:2019/id/${p.id} 2>/dev/null || true`,
      )
      .join("; ");

    try {
      const res = await sshExec(
        server.ipv4,
        deleteCmd,
        server.ssh_host_key || undefined,
      );
      if (res.exitCode !== 0) {
        // The batch is all-`|| true`, so a non-zero exit here means
        // something broke outside Caddy (SSH auth, command parser, etc.)
        // Don't mark anything as cleaned — we'll retry next tick.
        log(
          "delete",
          `server ${server.name}: batch delete non-zero exit: ${res.stderr}`,
        );
        continue;
      }
    } catch (err) {
      log("delete", `server ${server.name}: ssh failed: ${err}`);
      continue;
    }

    // Persist the new live config to disk so a Caddy restart doesn't
    // resurrect the legacies. Matches caddy-manager.ts:persistCaddyConfig —
    // warn on failure, don't throw, because the in-memory config is
    // already correct and a restart resurrecting a dead route is
    // self-healing on the next tick.
    try {
      const persist = await sshExec(
        server.ipv4,
        `curl -sf http://localhost:2019/config/ | tee /etc/caddy/caddy.json > /dev/null`,
        server.ssh_host_key || undefined,
      );
      if (persist.exitCode !== 0) {
        log(
          "persist",
          `server ${server.name}: failed to persist caddy.json: ${persist.stderr}`,
        );
      }
    } catch (err) {
      log("persist", `server ${server.name}: ssh failed during persist: ${err}`);
    }

    // Mark every (server, app) pair we just processed as cleaned. We do
    // this even if persist failed — the live config is already correct;
    // the persist failure is purely a durability concern.
    for (const p of pending) {
      cleaned.add(cleanedKey(server.id, p.appId));
    }
    log(
      "done",
      `server ${server.name}: cleaned ${pending.length} legacy route id(s)`,
    );
  }
}
