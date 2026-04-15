import * as db from "../../shared/db.ts";
import * as github from "../../shared/github.ts";
import {
  sshExec,
  removeContainer,
  removeCompose,
  removeAuthProxy,
} from "../../shared/remote/index.ts";
import { removeAppCaddy } from "../scale/caddy-manager.ts";
import { getComputeProvider, getDnsProvider } from "../../shared/providers/index.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type DestroyInput = { appId: number };

// Destroy steps are best-effort: each logs its failures and continues.
// No compensations — there is nothing to undo for a deletion that partially
// succeeded. We surface partial failures via detail strings only.

async function softStep<T>(ctx: { log: (s: string) => void }, name: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`[${name}] failed (continuing): ${msg}`);
    return { ok: false, error: msg };
  }
}

const removeGithubWebhook: Step<DestroyInput, { ok: boolean; error?: string }> = {
  name: "remove_github_webhook",
  label: "Remove GitHub webhook",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) return { ok: true };
    if (!app.webhook_enabled || !app.github_webhook_id) return { ok: true };
    const r = await softStep(ctx, "remove_github_webhook", async () => {
      const pat = await github.getGitHubPat(app.deployed_by || undefined);
      if (!pat) return;
      await github.deleteWebhook({
        gitRepo: app.git_repo,
        webhookId: app.github_webhook_id,
        token: pat,
      });
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

const stopAndRemoveContainers: Step<DestroyInput, { affectedServerIds: number[]; failed: boolean }> = {
  name: "stop_and_remove_containers",
  label: "Stop and remove containers",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) return { affectedServerIds: [], failed: false };
    const replicas = db.getReplicas(ctx.input.appId);
    const affected = new Set<number>();
    let failed = false;
    for (const replica of replicas) {
      affected.add(replica.server_id);
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;
      const r = await softStep(ctx, `rm ${replica.container_name}`, async () => {
        if (app.deploy_mode === "compose" && replica.container_name === app.name) {
          await removeCompose(server.ipv4, app.name, true, hostKey);
        } else {
          await removeContainer(server.ipv4, replica.container_name, hostKey);
        }
      });
      if (!r.ok) failed = true;
      await softStep(ctx, `rmdir ${app.name}`, async () => {
        await sshExec(server.ipv4, `rm -rf /home/deploy/apps/${app.name}`, hostKey);
      });
    }
    return { affectedServerIds: Array.from(affected), failed };
  },
};

const removeAuthProxyStep: Step<DestroyInput, { ok: boolean }> = {
  name: "remove_auth_proxy",
  label: "Remove auth proxy",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) return { ok: true };
    if (!app.auth_password) return { ok: true };
    const replicas = db.getReplicas(ctx.input.appId);
    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      await softStep(ctx, `remove_auth_proxy ${replica.container_name}`, async () => {
        await removeAuthProxy(server.ipv4, replica.container_name, server.ssh_host_key || undefined);
      });
    }
    return { ok: true };
  },
};

const removeCaddyRoute: Step<DestroyInput, { ok: boolean; error?: string }> = {
  name: "remove_caddy_route",
  label: "Remove Caddy route",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) return { ok: true };
    const r = await softStep(ctx, "remove_caddy_route", async () => {
      await removeAppCaddy(app.name, app.domain);
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

const deleteDnsRecords: Step<DestroyInput, { ok: boolean; failed: boolean }> = {
  name: "delete_dns_records",
  label: "Delete DNS records",
  async run(ctx) {
    const records = db.getDnsRecords(ctx.input.appId);
    if (records.length === 0) return { ok: true, failed: false };
    const dns = getDnsProvider();
    let failed = false;
    for (const record of records) {
      const r = await softStep(ctx, `delete_dns ${record.name}/${record.type}`, async () => {
        await dns.deleteRecord({
          zoneId: record.zone_id,
          name: record.name,
          type: record.type,
          value: record.value,
        });
      });
      if (!r.ok) failed = true;
    }
    return { ok: !failed, failed };
  },
};

const deleteVolume: Step<DestroyInput, { ok: boolean; error?: string }> = {
  name: "delete_volume",
  label: "Delete volume",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app || !app.volume_id) return { ok: true };
    const replicas = db.getReplicas(ctx.input.appId);
    const firstServer = replicas.length > 0 ? db.getServer(replicas[0].server_id) : null;
    const r = await softStep(ctx, "delete_volume", async () => {
      const compute = getComputeProvider(firstServer?.provider || "hetzner");
      await compute.volumes?.delete(app.volume_id);
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

const deleteDbRows: Step<DestroyInput, { ok: true }> = {
  name: "delete_db_rows",
  label: "Delete DB rows",
  async run(ctx, prior) {
    const containers = prior["stop_and_remove_containers"] as { failed: boolean } | undefined;
    const dnsOut = prior["delete_dns_records"] as { failed: boolean } | undefined;
    const volOut = prior["delete_volume"] as { ok: boolean } | undefined;
    const anyFailed = (containers?.failed) || (dnsOut?.failed) || (volOut && !volOut.ok);
    if (anyFailed) {
      // Resources couldn't be cleaned up. Mark app but don't delete DB rows yet.
      try { db.updateAppStatus(ctx.input.appId, "cleanup_failed"); } catch { /* ignore */ }
      ctx.log("Some resources could not be cleaned up — app marked cleanup_failed");
      return { ok: true };
    }
    const replicas = db.getReplicas(ctx.input.appId);
    for (const replica of replicas) {
      await softStep(ctx, `delete_replica ${replica.id}`, async () => {
        db.deleteReplica(replica.id);
      });
    }
    await softStep(ctx, "delete_app", async () => {
      db.deleteApp(ctx.input.appId);
    });
    return { ok: true };
  },
};

const gcEmptyServers: Step<DestroyInput, { ok: true }> = {
  name: "gc_empty_servers",
  label: "GC empty servers",
  async run(ctx, prior) {
    const containers = prior["stop_and_remove_containers"] as { affectedServerIds: number[] } | undefined;
    const ids = containers?.affectedServerIds || [];
    for (const sid of ids) {
      await softStep(ctx, `gc_server ${sid}`, async () => {
        await db.gcServerIfEmpty(sid);
      });
    }
    return { ok: true };
  },
};

const destroyAppOp: OpKindDefinition<DestroyInput> = {
  kind: "destroy_app",
  label: "Destroy app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [
    removeGithubWebhook,
    stopAndRemoveContainers,
    removeAuthProxyStep,
    removeCaddyRoute,
    deleteDnsRecords,
    deleteVolume,
    deleteDbRows,
    gcEmptyServers,
  ],
};

registerOp(destroyAppOp as OpKindDefinition<any>);

export default destroyAppOp;
export type { DestroyInput };
