import * as db from "../../shared/db.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { pullAndRunService, serviceHealthCheck, sshExec } from "../../shared/remote/index.ts";
import { getCatalogEntry, resolveServiceImage } from "../../shared/services/catalog.ts";
import { ensureVolumeBindMount } from "../hetzner/host-mounts.ts";
import { provisionServer } from "../provision-server.ts";
import { replicaBindHost } from "../scale/types.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RepairServiceInput = { serviceId: number; instanceId: number };

const repair: Step<RepairServiceInput, { serverId: number }> = {
  name: "repair_service_instance",
  label: "Repair service instance",
  async run(ctx) {
    const service = db.getService(ctx.input.serviceId);
    const instance = db.getServiceInstance(ctx.input.instanceId);
    if (!service || !instance || instance.service_id !== service.id) throw new Error("Service instance not found");
    if (service.status === "paused" || service.status === "cleanup_failed") {
      throw new Error(`Service is not repairable while status=${service.status}`);
    }
    const catalog = getCatalogEntry(service.service_type);
    if (!catalog) throw new Error(`Unknown service type ${service.service_type}`);

    const sourceServerId = instance.server_id;
    let server = db.getServer(instance.server_id);
    let moving = false;
    if (!server || server.status !== "ready") {
      const panelServerId = db.getPanel()?.server_id;
      server = db.getServers().find((candidate) =>
        candidate.status === "ready" && !candidate.gc_requested_at &&
        candidate.id !== panelServerId && candidate.pool === "general"
      ) ?? null;
      if (!server) {
        const settings = db.getSettings();
        if (!settings.default_server_type || !settings.default_location) {
          throw new Error("No ready repair target and default server settings are incomplete");
        }
        server = await provisionServer({
          serverType: settings.default_server_type,
          location: settings.default_location,
          name: `ocd-repair-${service.name}-${Date.now()}`,
          emit: (phase, detail) => ctx.log(`[${phase}] ${detail}`),
        });
      }
      moving = server.id !== sourceServerId;
    }

    let volume: Awaited<ReturnType<typeof hetzner.volumes.get>> | null = null;
    if (instance.volume_id) {
      if (!instance.volume_mount) throw new Error(`Service volume ${instance.volume_id} has no recorded mount path`);
      volume = await hetzner.volumes.get(instance.volume_id);
      if (volume.serverId && volume.serverId !== server.provider_id) {
        throw new Error(
          `Refusing automatic volume move: ${instance.volume_id} is attached to ${volume.serverId}, expected ${server.provider_id}`,
        );
      }
    }

    let hostPort = instance.host_port;
    let reservation: ReturnType<typeof db.reserveHostPort> | null = null;
    try {
      db.updateServiceInstanceStatus(instance.id, "deploying");
      db.updateServiceStatus(service.id, "deploying");
      if (moving) {
        hostPort = db.nextServiceHostPort(server.id);
        for (;;) {
          try {
            reservation = db.reserveHostPort({
              serverId: server.id,
              bindAddress: replicaBindHost(server),
              hostPort,
              ownerType: "service-repair",
              ownerId: String(instance.id),
            });
            break;
          } catch (error) {
            if (!(error instanceof Error && error.message.startsWith("Port preflight failed:"))) throw error;
            if (hostPort >= 19999) throw error;
            hostPort++;
          }
        }
        const probe = await sshExec(
          server.ipv4,
          `su - deploy -c ${JSON.stringify(`docker ps --filter publish=${hostPort} --format '{{.Names}}'`)}`,
          server.ssh_host_key || undefined,
        );
        const conflicts = probe.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
          .filter((name) => name !== instance.container_name);
        if (probe.exitCode !== 0 || conflicts.length > 0) {
          throw new Error(
            `Repair target port ${hostPort} is unavailable${conflicts.length ? ` (${conflicts.join(", ")})` : ""}`,
          );
        }
      }

      if (instance.volume_id && volume && !volume.serverId) {
        await hetzner.volumes.attach(instance.volume_id, server.provider_id);
      }
      if (instance.volume_id) {
        await ensureVolumeBindMount({
          serverIp: server.ipv4,
          hostKey: server.ssh_host_key || undefined,
          hetznerVolumeId: instance.volume_id,
          hostMountPath: instance.volume_mount.split(":")[0],
          blockName: `svc-${service.id}`,
        });
      }

      await pullAndRunService(server.ipv4, {
        name: instance.container_name,
        image: resolveServiceImage(catalog, service.version),
        port: service.port,
        hostPort,
        envVars: JSON.parse(service.env_vars || "{}") as Record<string, string>,
        volumeMount: instance.volume_mount || undefined,
        bindAddress: replicaBindHost(server),
        cmd: catalog.cmd,
        memoryMb: catalog.memoryMb,
        cpus: catalog.cpus,
        extraCaps: catalog.extraCaps,
      }, server.ssh_host_key || undefined);
      const health = await serviceHealthCheck(
        server.ipv4,
        instance.container_name,
        catalog.healthCmd,
        10,
        server.ssh_host_key || undefined,
      );
      if (!health.healthy) throw new Error(health.error || "Repaired service did not become healthy");
      if (moving) {
        db.updateServiceInstancePlacement(instance.id, server.id, hostPort);
        await db.gcServerIfEmpty(sourceServerId);
      }
      db.updateServiceInstanceStatus(instance.id, "running");
      db.updateServiceStatus(service.id, "running");
      return { serverId: server.id };
    } catch (error) {
      db.updateServiceInstanceStatus(instance.id, "unhealthy");
      db.updateServiceStatus(service.id, "unhealthy");
      if (moving) await db.gcServerIfEmpty(server.id);
      throw error;
    } finally {
      if (reservation) db.releaseHostPortReservation(reservation.id);
    }
  },
};

const repairServiceOp: OpKindDefinition<RepairServiceInput> = {
  kind: "repair_service",
  label: "Repair service",
  resourceKeys: (input) => {
    const instance = db.getServiceInstance(input.instanceId);
    return [
      `service:${input.serviceId}`,
      ...(instance ? [`server:${instance.server_id}`] : []),
      ...(instance?.volume_id ? [`volume:${instance.volume_id}`] : []),
    ];
  },
  steps: [repair],
};

registerOp(repairServiceOp as OpKindDefinition<any>);
export default repairServiceOp;
export type { RepairServiceInput };
