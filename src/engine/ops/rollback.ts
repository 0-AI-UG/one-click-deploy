import * as db from "../../shared/db.ts";
import {
  sshExec,
  removeContainer,
  healthCheck,
  composeHealthCheck,
  describeFailure,
} from "../../shared/remote/index.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { replicaBindHost } from "../scale/types.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RollbackInput = {
  appId: number;
  deploymentId: number;
};

type TargetOut = {
  appId: number;
  replicaId: number;
  serverId: number;
  gitCommit: string;
  imageTag: string;
  previousStatus: string;
  deployMode: string;
};

type SwapOut = { containerName: string };

function parseExtraVolumes(raw: string): string[] {
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

const loadTargetDeployment: Step<RollbackInput, TargetOut> = {
  name: "load_target_deployment",
  label: "Load target deployment",
  async run(ctx) {
    const app = db.getAppUnscoped(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const first = replicas[0];
    const deployment = db.getDeploymentUnscoped(ctx.input.deploymentId);
    if (!deployment) throw new Error("Deployment not found");
    if (deployment.app_id !== ctx.input.appId) throw new Error("Deployment does not belong to this app");
    return {
      appId: ctx.input.appId,
      replicaId: first.id,
      serverId: first.server_id,
      gitCommit: deployment.git_commit,
      imageTag: deployment.image_tag,
      previousStatus: app.status,
      deployMode: app.deploy_mode,
    };
  },
};

const swapContainerToTarget: Step<RollbackInput, SwapOut> = {
  name: "swap_container_to_target",
  label: "Swap to target",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const app = db.getAppUnscoped(target.appId);
    if (!app) throw new Error("App not found");
    const server = db.getServerUnscoped(target.serverId);
    if (!server) throw new Error("Server not found");
    const replicas = db.getReplicas(target.appId);
    const first = replicas[0];
    const hostPort = first.host_port;
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
    const appDir = `/home/deploy/apps/${app.name}`;

    await sshExec(server.ipv4, asUser(`cd ${appDir} && git checkout ${target.gitCommit}`), hostKey);

    const envVars = await resolveAppEnvVars(app);
    const envEntries = Object.entries(envVars);
    if (envEntries.length > 0) {
      const envFilePath = `${appDir}/.env.deploy`;
      const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
      const escapedContent = envFileContent.replace(/'/g, "'\\''");
      await sshExec(
        server.ipv4,
        `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`,
        hostKey,
      );
    }

    if (target.deployMode === "compose") {
      const envFileFlag = envEntries.length > 0 ? `--env-file ${appDir}/.env.deploy` : "";
      const composeCmd = `cd ${appDir} && docker compose -f ${app.compose_file} -f docker-compose.ocd.yml -p ${app.name} ${envFileFlag} up -d --build`;
      const result = await sshExec(server.ipv4, asUser(composeCmd), hostKey);
      if (result.exitCode !== 0) {
        throw new Error(describeFailure("Failed to rollback compose project", result));
      }
    } else {
      let dockerfilePath = app.dockerfile_path?.replace(/^\/+/, "");
      if (!dockerfilePath) {
        const findResult = await sshExec(
          server.ipv4,
          asUser(`cd ${appDir} && if [ -f Dockerfile ]; then echo Dockerfile; elif [ -f docker/Dockerfile ]; then echo docker/Dockerfile; else find . -maxdepth 3 -name Dockerfile -type f | head -1 | sed 's|^\\./||'; fi`),
          hostKey,
        );
        dockerfilePath = findResult.stdout.trim();
        if (!dockerfilePath) throw new Error("No Dockerfile found in repository for rollback");
      }
      const dockerContext = app.docker_context || ".";
      const buildCmd = `cd ${appDir} && docker build -t ${app.name}:latest -f ${dockerfilePath} ${dockerContext}`;
      const buildResult = await sshExec(server.ipv4, asUser(buildCmd), hostKey);
      if (buildResult.exitCode !== 0) {
        throw new Error(describeFailure("Failed to rollback (docker build)", buildResult));
      }
      await removeContainer(server.ipv4, app.name, hostKey);
      const envFileFlag = envEntries.length > 0 ? `--env-file ${appDir}/.env.deploy` : "";
      const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
      const extraVolFlags = parseExtraVolumes(app.extra_volumes).map((v) => `-v ${v}`).join(" ");
      const cmd = `docker run -d --name ${app.name} --restart unless-stopped -p ${bindAddr}:${hostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${extraVolFlags} ${app.name}:latest`;
      const runResult = await sshExec(server.ipv4, asUser(cmd), hostKey);
      if (runResult.exitCode !== 0) {
        throw new Error(describeFailure("Failed to start container after rollback rebuild", runResult));
      }
    }
    return { containerName: app.name };
  },
  async compensate(ctx, _out, prior) {
    const target = prior["load_target_deployment"] as TargetOut | undefined;
    if (!target) return;
    try { db.updateAppStatus(target.appId, target.previousStatus); } catch (err) {
      ctx.log(`Failed to restore previous status: ${err}`);
    }
  },
};

const syncCaddyStep: Step<RollbackInput, { ok: true }> = {
  name: "sync_caddy",
  label: "Configure Caddy",
  async run(ctx) {
    try {
      const { syncAppCaddy } = await import("../scale/caddy-manager.ts");
      await syncAppCaddy(ctx.input.appId);
    } catch (err) {
      ctx.log(`Caddy sync warning: ${err}`);
    }
    return { ok: true };
  },
};

const healthCheckStep: Step<RollbackInput, { healthy: boolean }> = {
  name: "health_check",
  label: "Health check",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const app = db.getAppUnscoped(target.appId);
    if (!app) throw new Error("App not found");
    const server = db.getServerUnscoped(target.serverId);
    if (!server) throw new Error("Server not found");
    const replicas = db.getReplicas(target.appId);
    const first = replicas[0];
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;
    const health = target.deployMode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, bindAddr, first.host_port, 5, hostKey)
      : await healthCheck(server.ipv4, app.name, bindAddr, first.host_port, 5, hostKey);
    db.updateAppStatus(target.appId, health.healthy ? "running" : "unhealthy");
    return { healthy: health.healthy };
  },
};

const recordRollback: Step<RollbackInput, { deploymentId: number }> = {
  name: "record_rollback",
  label: "Record rollback",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const row = db.insertDeployment({
      app_id: target.appId,
      image_tag: target.imageTag,
      git_commit: `rollback-from-${target.gitCommit}`,
    });
    db.appendDeployLog(
      target.appId,
      `[rollback] Rolled back to deployment ${ctx.input.deploymentId} (${target.imageTag})`,
    );
    return { deploymentId: row.id };
  },
};

const rollbackOp: OpKindDefinition<RollbackInput> = {
  kind: "rollback",
  label: "Rollback app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [
    loadTargetDeployment,
    swapContainerToTarget,
    syncCaddyStep,
    healthCheckStep,
    recordRollback,
  ],
};

registerOp(rollbackOp);

export default rollbackOp;
export type { RollbackInput };
