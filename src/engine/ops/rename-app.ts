import * as db from "../../shared/db.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RenameAppInput = { appId: number; newName: string };

const renameOnServers: Step<RenameAppInput, { ok: true }> = {
  name: "rename_app",
  label: "Rename app",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const newName = ctx.input.newName;
    if (newName === app.name) return { ok: true };

    const existing = db.getAppByName(newName, ctx.orgId);
    if (existing && existing.id !== app.id) {
      throw new Error(`An app named "${newName}" already exists`);
    }

    // Rename container and directory on each server hosting a replica.
    const replicas = db.getReplicas(ctx.input.appId);
    for (const replica of replicas) {
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;

      if (app.deploy_mode === "compose") {
        await sshExec(
          server.ipv4,
          `su - deploy -c "mv /home/deploy/apps/${app.name} /home/deploy/apps/${newName} 2>/dev/null || true"`,
          hostKey,
        );
      } else {
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
      }
    }

    db.renameApp(ctx.input.appId, newName);
    return { ok: true };
  },
};

const renameAppOp: OpKindDefinition<RenameAppInput> = {
  kind: "rename_app",
  label: "Rename app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [renameOnServers],
};

registerOp(renameAppOp);

export default renameAppOp;
export type { RenameAppInput };
