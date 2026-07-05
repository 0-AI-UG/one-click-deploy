import * as db from "../../shared/db.ts";
import {
  sshExec,
  removeContainer,
  healthCheck,
  composeHealthCheck,
  describeFailure,
  buildDockerRunArgs,
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

type CheckoutOut = { envFilePath: string | null };
type RebuildOut = { dockerfilePath: string | null };
type PriorContainerSnapshot = {
  image: string;
  envFilePath: string | null;
  hostPort: number;
  containerPort: number;
  bindAddr: string;
  volumeMount: string | null;
  extraVolumes: string[];
} | null;
type SwapOut = { containerName: string; priorSnapshot: PriorContainerSnapshot };

function parseExtraVolumes(raw: string): string[] {
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

const loadTargetDeployment: Step<RollbackInput, TargetOut> = {
  name: "load_target_deployment",
  label: "Load target deployment",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const replicas = db.getReplicas(ctx.input.appId);
    if (replicas.length === 0) throw new Error("App has no replicas");
    const first = replicas[0];
    const deployment = db.getDeployment(ctx.input.deploymentId);
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

const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

const checkoutTarget: Step<RollbackInput, CheckoutOut> = {
  name: "checkout_target",
  label: "Checkout target commit",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const app = db.getApp(target.appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(target.serverId);
    if (!server) throw new Error("Server not found");
    const hostKey = server.ssh_host_key || undefined;
    const appDir = `/home/deploy/apps/${app.name}`;

    await sshExec(server.ipv4, asUser(`cd ${appDir} && git checkout ${target.gitCommit}`), hostKey);

    const envVars = await resolveAppEnvVars(app);
    const envEntries = Object.entries(envVars);
    let envFilePath: string | null = null;
    if (envEntries.length > 0) {
      envFilePath = `${appDir}/.env.deploy`;
      const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
      const escapedContent = envFileContent.replace(/'/g, "'\\''");
      await sshExec(
        server.ipv4,
        `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`,
        hostKey,
      );
    }
    return { envFilePath };
  },
};

const rebuildImage: Step<RollbackInput, RebuildOut> = {
  name: "rebuild_image",
  label: "Rebuild image",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    if (target.deployMode === "compose") {
      // Compose build happens together with `up -d --build` in swap_container.
      return { dockerfilePath: null };
    }
    const app = db.getApp(target.appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(target.serverId);
    if (!server) throw new Error("Server not found");
    const hostKey = server.ssh_host_key || undefined;
    const appDir = `/home/deploy/apps/${app.name}`;

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
    const dockerContext = (app as any).docker_context || ".";
    const buildCmd = `cd ${appDir} && docker build -t ${app.name}:latest -f ${dockerfilePath} ${dockerContext}`;
    const buildResult = await sshExec(server.ipv4, asUser(buildCmd), hostKey);
    if (buildResult.exitCode !== 0) {
      throw new Error(describeFailure("Failed to rollback (docker build)", buildResult));
    }
    return { dockerfilePath };
  },
};

const swapContainer: Step<RollbackInput, SwapOut> = {
  name: "swap_container",
  label: "Swap container",
  async run(ctx, prior) {
    const target = prior["load_target_deployment"] as TargetOut;
    const checkout = prior["checkout_target"] as CheckoutOut;
    const app = db.getApp(target.appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(target.serverId);
    if (!server) throw new Error("Server not found");
    const replicas = db.getReplicas(target.appId);
    const first = replicas[0];
    const hostPort = first.host_port;
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;
    const appDir = `/home/deploy/apps/${app.name}`;
    const envFileFlag = checkout.envFilePath ? `--env-file ${checkout.envFilePath}` : "";

    let priorSnapshot: PriorContainerSnapshot = null;
    if (target.deployMode === "compose") {
      const composeCmd = `cd ${appDir} && docker compose -f ${app.compose_file} -f docker-compose.ocd.yml -p ${app.name} ${envFileFlag} up -d --build`;
      const result = await sshExec(server.ipv4, asUser(composeCmd), hostKey);
      if (result.exitCode !== 0) {
        throw new Error(describeFailure("Failed to rollback compose project", result));
      }
    } else {
      // Snapshot the running container before removing so compensate can
      // restart the prior image if any later step in this op fails.
      try {
        const inspect = await sshExec(
          server.ipv4,
          `docker inspect ${app.name} --format '{{.Config.Image}}' 2>/dev/null || true`,
          hostKey,
        );
        const priorImage = inspect.stdout.trim();
        if (priorImage) {
          priorSnapshot = {
            image: priorImage,
            envFilePath: checkout.envFilePath,
            hostPort,
            containerPort: app.container_port,
            bindAddr,
            volumeMount: app.volume_mount || null,
            extraVolumes: parseExtraVolumes(app.extra_volumes),
          };
        }
      } catch (err) {
        ctx.log(`Failed to snapshot prior container (compensate may be no-op): ${err}`);
      }

      await removeContainer(server.ipv4, app.name, hostKey);
      const cmd = buildDockerRunArgs({
        name: app.name,
        image: `${app.name}:latest`,
        appName: app.name,
        network: null,
        publish: { bindAddr, hostPort, containerPort: app.container_port },
        envFilePath: checkout.envFilePath || undefined,
        volumeMount: app.volume_mount || undefined,
        extraVolumes: parseExtraVolumes(app.extra_volumes),
        memoryMb: app.memory_mb || undefined,
      });
      const runResult = await sshExec(server.ipv4, asUser(cmd), hostKey);
      if (runResult.exitCode !== 0) {
        throw new Error(describeFailure("Failed to start container after rollback rebuild", runResult));
      }
    }
    return { containerName: app.name, priorSnapshot };
  },
  async compensate(ctx, out, prior) {
    const target = prior["load_target_deployment"] as TargetOut | undefined;
    if (!target) return;
    try { db.updateAppStatus(target.appId, target.previousStatus); } catch (err) {
      ctx.log(`Failed to restore previous status: ${err}`);
    }
    // Best-effort: restart the prior container image if we captured one.
    const snap = out?.priorSnapshot;
    if (!snap || target.deployMode === "compose") return;
    try {
      const app = db.getApp(target.appId);
      const server = db.getServer(target.serverId);
      if (!app || !server) return;
      const hostKey = server.ssh_host_key || undefined;
      await removeContainer(server.ipv4, app.name, hostKey);
      const cmd = buildDockerRunArgs({
        name: app.name,
        image: snap.image,
        appName: app.name,
        network: null,
        publish: { bindAddr: snap.bindAddr, hostPort: snap.hostPort, containerPort: snap.containerPort },
        envFilePath: snap.envFilePath || undefined,
        volumeMount: snap.volumeMount || undefined,
        extraVolumes: snap.extraVolumes,
        memoryMb: app.memory_mb || undefined,
      });
      await sshExec(server.ipv4, asUser(cmd), hostKey);
      ctx.log(`Restored prior container image ${snap.image}`);
    } catch (err) {
      ctx.log(`Failed to restore prior container: ${err}`);
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
    const app = db.getApp(target.appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(target.serverId);
    if (!server) throw new Error("Server not found");
    const replicas = db.getReplicas(target.appId);
    const first = replicas[0];
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;
    const health = target.deployMode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, bindAddr, first.host_port, 10, hostKey)
      : await healthCheck(server.ipv4, app.name, bindAddr, first.host_port, 10, hostKey);
    db.updateAppStatus(target.appId, health.healthy ? "running" : "unhealthy");
    if (!health.healthy) {
      // Fail the op so swap_container's compensate restores the prior image
      // instead of leaving the app on a broken rolled-back version.
      db.appendDeployLog(target.appId, `[health] Rollback target unhealthy: ${health.error || `HTTP ${health.statusCode ?? "no response"}`}`);
      throw new Error(`App did not become healthy after rollback: ${health.error || "health check failed"}`);
    }
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
    checkoutTarget,
    rebuildImage,
    swapContainer,
    syncCaddyStep,
    healthCheckStep,
    recordRollback,
  ],
};

registerOp(rollbackOp as OpKindDefinition<any>);

export default rollbackOp;
export type { RollbackInput };
