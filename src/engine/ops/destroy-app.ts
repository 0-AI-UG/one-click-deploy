import * as db from "../../shared/db.ts";
import * as github from "../../shared/github.ts";
import {
  sshExec,
  removeContainer,
} from "../../shared/remote/index.ts";
import { syncAllTraefik } from "../scale/traefik-manager.ts";
import { hetzner, hetznerDns } from "../../shared/providers/index.ts";
import { registerOp } from "./registry.ts";
import { softStep, runDbCleanupGate, makeGcEmptyServersStep } from "./_shared.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type DestroyInput = { appId: number };

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
        await removeContainer(server.ipv4, replica.container_name, hostKey);
      });
      if (!r.ok) failed = true;
      await softStep(ctx, `rmdir ${app.name}`, async () => {
        await sshExec(server.ipv4, `rm -rf /home/deploy/apps/${app.name}`, hostKey);
      });
    }
    return { affectedServerIds: Array.from(affected), failed };
  },
};

// Runs AFTER delete_db_rows: ingress is a desired-state render of the DB, so
// the app's routers only disappear from the rendered config once its rows are
// gone. (If the row deletion was skipped because of upstream failures, this
// re-render is a harmless no-op and the reconciler converges later.)
const removeIngressRoute: Step<DestroyInput, { ok: boolean; error?: string }> = {
  name: "remove_ingress_route",
  label: "Remove ingress route",
  async run(ctx) {
    const r = await softStep(ctx, "remove_ingress_route", async () => {
      await syncAllTraefik();
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
    const dns = hetznerDns;
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
    const r = await softStep(ctx, "delete_volume", async () => {
      const compute = hetzner;
      if (app.volume_attached) {
        // Pre-existing volume attached via attach_existing_volume — it predates
        // us and may hold data we don't own. DETACH only; never delete.
        await compute.volumes?.detach(app.volume_id);
      } else {
        await compute.volumes?.delete(app.volume_id);
      }
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

const deleteDbRows: Step<DestroyInput, { ok: true }> = {
  name: "delete_db_rows",
  label: "Delete DB rows",
  async run(ctx, prior) {
    // Gate: if ANY upstream destroy step partially failed, do not delete DB
    // rows. Mark the app `cleanup_failed` and surface to the reconciler.
    const failedSteps = runDbCleanupGate(prior);
    if (failedSteps.length > 0) {
      try { db.updateAppStatus(ctx.input.appId, "cleanup_failed"); } catch { /* ignore */ }
      ctx.log(`Some resources could not be cleaned up (failed: ${failedSteps.join(", ")}) — app marked cleanup_failed`);
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

const gcEmptyServers = makeGcEmptyServersStep<DestroyInput>("stop_and_remove_containers");

const destroyAppOp: OpKindDefinition<DestroyInput> = {
  kind: "destroy_app",
  label: "Destroy app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [
    removeGithubWebhook,
    stopAndRemoveContainers,
    deleteDnsRecords,
    deleteVolume,
    deleteDbRows,
    removeIngressRoute,
    gcEmptyServers,
  ],
};

registerOp(destroyAppOp as OpKindDefinition<any>);

export default destroyAppOp;
export type { DestroyInput };
