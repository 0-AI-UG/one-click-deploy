import * as db from "../../shared/db.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RenameAppInput = { appId: number; newName: string };

type RenameOut = {
  oldName: string;
  newName: string;
  serversRenamed: number[];
  dbRenamed: boolean;
};

const renameOnServers: Step<RenameAppInput, RenameOut> = {
  name: "rename_app",
  label: "Rename app",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const newName = ctx.input.newName;
    const out: RenameOut = {
      oldName: app.name,
      newName,
      serversRenamed: [],
      dbRenamed: false,
    };
    if (newName === app.name) return out;

    const existing = db.getAppByName(newName);
    if (existing && existing.id !== app.id) {
      throw new Error(`An app named "${newName}" already exists`);
    }

    // Rename container and directory on each server hosting a replica.
    // Track which servers succeeded so compensate can revert only those.
    const replicas = db.getReplicas(ctx.input.appId);
    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;

      await sshExec(
        server.ipv4,
        `su - deploy -c "docker rename ${app.name} ${newName} 2>/dev/null || true"`,
        hostKey,
      );
      await sshExec(
        server.ipv4,
        `su - deploy -c "mv /home/deploy/apps/${app.name} /home/deploy/apps/${newName} 2>/dev/null || true"`,
        hostKey,
      );
      out.serversRenamed.push(server.id);
    }

    db.renameApp(ctx.input.appId, newName);
    out.dbRenamed = true;

    // Re-render ingress: router/service names derive from the app name, so
    // a rename must resync or the old routes linger until the next
    // reconciler tick. Best-effort — the reconciler converges regardless.
    try {
      await syncAppIngress(ctx.input.appId);
    } catch (err) {
      ctx.log(`Ingress resync after rename failed (reconciler will converge): ${err}`);
    }
    return out;
  },
  async compensate(ctx, out) {
    if (!out) return;
    // Revert the DB name first: it is the source of truth the reconciler and
    // ingress render from, so a failure to revert it is a real DB/reality
    // divergence — let it PROPAGATE to `compensation_failed` rather than hide
    // behind a clean `compensated`. Renaming to a name it may already hold is a
    // harmless no-op, so re-running the compensate is safe.
    if (out.dbRenamed) {
      db.renameApp(ctx.input.appId, out.oldName);
    }
    for (const serverId of out.serversRenamed) {
      const server = db.getServer(serverId);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;
      // `docker rename`/`mv ... || true` are idempotent (no-op when the newName
      // artifact is already gone), so the remote command exits 0 for those. A
      // nonzero exit is therefore an SSH transport failure — we couldn't reach
      // the host to un-rename, leaving the container/dir name diverged from the
      // reverted DB. Surface that instead of swallowing it.
      const r1 = await sshExec(
        server.ipv4,
        `su - deploy -c "docker rename ${out.newName} ${out.oldName} 2>/dev/null || true"`,
        hostKey,
      );
      const r2 = await sshExec(
        server.ipv4,
        `su - deploy -c "mv /home/deploy/apps/${out.newName} /home/deploy/apps/${out.oldName} 2>/dev/null || true"`,
        hostKey,
      );
      if (r1.exitCode !== 0 || r2.exitCode !== 0) {
        throw new Error(`Could not reach server ${serverId} over SSH to revert rename of app ${ctx.input.appId}`);
      }
    }
  },
};

const renameAppOp: OpKindDefinition<RenameAppInput> = {
  kind: "rename_app",
  label: "Rename app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [renameOnServers],
};

registerOp(renameAppOp as OpKindDefinition<any>);

export default renameAppOp;
export type { RenameAppInput };
