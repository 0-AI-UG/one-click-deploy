import * as db from "../../shared/db.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { pullAndRunService, removeContainer, serviceHealthCheck, sshExec } from "../../shared/remote/index.ts";
import { getCatalogEntry, resolveServiceImage } from "../../shared/services/catalog.ts";
import { bindMountStatus, ensureVolumeBindMount, removeVolumeBindMount } from "../hetzner/host-mounts.ts";
import { replicaBindHost } from "../scale/types.ts";
import { registerOp } from "./registry.ts";
import { FatalProbeError, type OpKindDefinition, type Step } from "../types.ts";

type RepairServiceInput = { serviceId: number; instanceId: number };
type TargetOut = {
  sourceServerId: number;
  sourceHostPort: number;
  targetServerId: number;
  moving: boolean;
};
type ReservationOut = { id: number | null; hostPort: number };
type VolumeOut = { providerId: string; initialServerId: string | null } | null;
type AttachOut = { attachedByOperation: boolean };
type HealthOut = { healthy: boolean; error?: string };
type StatusOut = { priorServiceStatus: string; priorInstanceStatus: string };

function loadRows(input: RepairServiceInput) {
  const service = db.getService(input.serviceId);
  const instance = db.getServiceInstance(input.instanceId);
  if (!service || !instance || instance.service_id !== service.id) {
    throw new Error("Service instance not found");
  }
  const catalog = getCatalogEntry(service.service_type);
  if (!catalog) throw new Error(`Unknown service type ${service.service_type}`);
  return { service, instance, catalog };
}

function targetFrom(prior: Record<string, unknown>): TargetOut {
  const target = prior["select_repair_target"] as TargetOut | undefined;
  if (!target) throw new Error("Repair target was not selected");
  return target;
}

function reservationFrom(prior: Record<string, unknown>): ReservationOut {
  const reservation = prior["reserve_target_port"] as ReservationOut | undefined;
  if (!reservation) throw new Error("Repair port was not selected");
  return reservation;
}

const selectRepairTarget: Step<RepairServiceInput, TargetOut> = {
  name: "select_repair_target",
  label: "Select repair target",
  async run(ctx, prior) {
    const { service, instance } = loadRows(ctx.input);
    if (service.status === "paused" || service.status === "cleanup_failed") {
      throw new Error(`Service is not repairable while status=${service.status}`);
    }
    const source = db.getServer(instance.server_id);
    const panelServerId = db.getPanel()?.server_id;
    const target = source?.status === "ready"
      ? source
      : db.getServers().find((candidate) =>
        candidate.status === "ready" &&
        !candidate.gc_requested_at &&
        candidate.id !== panelServerId &&
        candidate.pool === (service.placement_pool || "general")
      );
    if (!target) {
      throw new Error(
        `No ready repair target exists in pool '${service.placement_pool || "general"}'. ` +
        "Create and approve capacity before retrying repair.",
      );
    }
    return {
      sourceServerId: instance.server_id,
      sourceHostPort: instance.host_port,
      targetServerId: target.id,
      moving: target.id !== instance.server_id,
    };
  },
};

const inspectVolume: Step<RepairServiceInput, VolumeOut> = {
  name: "inspect_volume",
  label: "Inspect service volume",
  async run(ctx, prior) {
    const { instance } = loadRows(ctx.input);
    if (!instance.volume_id) return null;
    if (!instance.volume_mount) {
      throw new Error(`Service volume ${instance.volume_id} has no recorded mount path`);
    }
    const volume = await hetzner.volumes.get(instance.volume_id);
    const target = db.getServer(targetFrom(prior).targetServerId);
    if (!target) throw new Error("Repair target server disappeared");
    if (volume.serverId && volume.serverId !== target.provider_id) {
      throw new FatalProbeError(
        `Refusing automatic volume move: ${instance.volume_id} is attached to ${volume.serverId}, expected ${target.provider_id}`,
      );
    }
    return { providerId: instance.volume_id, initialServerId: volume.serverId };
  },
};

const markDeploying: Step<RepairServiceInput, StatusOut> = {
  name: "mark_deploying",
  label: "Mark repair in progress",
  async run(ctx) {
    const { service, instance } = loadRows(ctx.input);
    const out = { priorServiceStatus: service.status, priorInstanceStatus: instance.status };
    db.updateServiceInstanceStatus(instance.id, "deploying");
    db.updateServiceStatus(service.id, "deploying");
    return out;
  },
  async compensate(ctx) {
    // A failed repair is not the prior healthy state. Persist the failure so
    // the reconciler/operator can see and retry it.
    try { db.updateServiceInstanceStatus(ctx.input.instanceId, "unhealthy"); } catch { /* best effort */ }
    try { db.updateServiceStatus(ctx.input.serviceId, "unhealthy"); } catch { /* best effort */ }
  },
};

const reserveTargetPort: Step<RepairServiceInput, ReservationOut> = {
  name: "reserve_target_port",
  label: "Reserve target port",
  async run(ctx, prior) {
    const target = targetFrom(prior);
    if (!target.moving) return { id: null, hostPort: target.sourceHostPort };
    const server = db.getServer(target.targetServerId);
    if (!server) throw new Error("Repair target server disappeared");

    // Clear only this operation's abandoned claim before retrying an
    // interrupted reserve call. The idempotency owner is operation-scoped.
    db.releaseHostPortReservations("service-repair", String(ctx.opId));
    let hostPort = db.nextServiceHostPort(server.id);
    for (;;) {
      if (hostPort > 19999) throw new Error(`No repair port is available on server ${server.name}`);
      try {
        const reservation = db.reserveHostPort({
          serverId: server.id,
          bindAddress: replicaBindHost(server),
          hostPort,
          ownerType: "service-repair",
          ownerId: String(ctx.opId),
        });
        return { id: reservation.id, hostPort };
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith("Port preflight failed:"))) throw error;
        if (hostPort >= 19999) throw error;
        hostPort++;
      }
    }
  },
  async compensate(ctx) {
    db.releaseHostPortReservations("service-repair", String(ctx.opId));
  },
  async probeCompensated(ctx) {
    // Deletion is idempotent and scoped, so performing it is cheaper and more
    // reliable than adding an ownership-query surface solely for this probe.
    db.releaseHostPortReservations("service-repair", String(ctx.opId));
    return true;
  },
};

const verifyTargetPort: Step<RepairServiceInput, { ok: true }> = {
  name: "verify_target_port",
  label: "Verify target port",
  async run(_ctx, prior) {
    const target = targetFrom(prior);
    if (!target.moving) return { ok: true };
    const server = db.getServer(target.targetServerId);
    const reservation = reservationFrom(prior);
    const { instance } = loadRows(_ctx.input);
    if (!server) throw new Error("Repair target server disappeared");
    const probe = await sshExec(
      server.ipv4,
      `su - deploy -c ${JSON.stringify(`docker ps --filter publish=${reservation.hostPort} --format '{{.Names}}'`)}`,
      server.ssh_host_key || undefined,
    );
    const conflicts = probe.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean)
      .filter((name) => name !== instance.container_name);
    if (probe.exitCode !== 0 || conflicts.length > 0) {
      throw new Error(
        `Repair target port ${reservation.hostPort} is unavailable${conflicts.length ? ` (${conflicts.join(", ")})` : ""}`,
      );
    }
    return { ok: true };
  },
};

const attachVolume: Step<RepairServiceInput, AttachOut> = {
  name: "attach_volume",
  label: "Attach service volume",
  async probe(ctx, prior) {
    const inspected = prior["inspect_volume"] as VolumeOut | undefined;
    if (!inspected) return { attachedByOperation: false };
    const target = db.getServer(targetFrom(prior).targetServerId);
    if (!target) throw new FatalProbeError("Repair target server disappeared");
    const current = await hetzner.volumes.get(inspected.providerId);
    if (current.serverId === target.provider_id) {
      return { attachedByOperation: inspected.initialServerId == null };
    }
    if (current.serverId) {
      throw new FatalProbeError(
        `Refusing automatic volume move: ${inspected.providerId} is attached to ${current.serverId}, expected ${target.provider_id}`,
      );
    }
    return null;
  },
  async run(_ctx, prior) {
    const inspected = prior["inspect_volume"] as VolumeOut | undefined;
    if (!inspected) return { attachedByOperation: false };
    if (inspected.initialServerId) return { attachedByOperation: false };
    const target = db.getServer(targetFrom(prior).targetServerId);
    if (!target) throw new Error("Repair target server disappeared");
    let attachReturned = false;
    try {
      await hetzner.volumes.attach(inspected.providerId, target.provider_id);
      attachReturned = true;
      const confirmed = await hetzner.volumes.get(inspected.providerId);
      if (confirmed.serverId !== target.provider_id) {
        throw new Error(
          `Volume attach did not converge: ${inspected.providerId} is attached to ${confirmed.serverId || "nothing"}`,
        );
      }
      return { attachedByOperation: true };
    } catch (error) {
      // A provider call can succeed remotely and then fail locally. Since a
      // failed forward step never receives engine compensation, clean up an
      // observed/acknowledged partial attachment inline.
      let attachedHere = attachReturned;
      if (!attachedHere) {
        try {
          attachedHere = (await hetzner.volumes.get(inspected.providerId)).serverId === target.provider_id;
        } catch { /* retain ambiguity; do not detach a foreign attachment */ }
      }
      if (attachedHere) {
        try {
          await hetzner.volumes.detach(inspected.providerId);
        } catch (rollbackError) {
          throw new Error(`Volume attach failed (${error}); inline detach also failed: ${rollbackError}`);
        }
      }
      throw error;
    }
  },
  async compensate(_ctx, out, prior) {
    const inspected = prior["inspect_volume"] as VolumeOut | undefined;
    if (out.attachedByOperation && inspected) await hetzner.volumes.detach(inspected.providerId);
  },
  async probeCompensated(_ctx, out, prior) {
    if (!out.attachedByOperation) return true;
    const inspected = prior["inspect_volume"] as VolumeOut | undefined;
    if (!inspected) return true;
    return (await hetzner.volumes.get(inspected.providerId)).serverId == null;
  },
};

const ensureBindMount: Step<RepairServiceInput, { ok: true; skipped?: boolean; createdByOperation?: boolean }> = {
  name: "ensure_volume_bind_mount",
  label: "Mount service volume",
  async run(ctx, prior) {
    const inspected = prior["inspect_volume"] as VolumeOut | undefined;
    if (!inspected) return { ok: true, skipped: true };
    const { service, instance } = loadRows(ctx.input);
    const server = db.getServer(targetFrom(prior).targetServerId);
    if (!server) throw new Error("Repair target server disappeared");
    const mountOpts = {
      serverIp: server.ipv4,
      hostKey: server.ssh_host_key || undefined,
      hetznerVolumeId: inspected.providerId,
      hostMountPath: instance.volume_mount.split(":")[0],
      blockName: `svc-${service.id}`,
    };
    const before = await bindMountStatus({
      ...mountOpts,
      expectedVolumeId: inspected.providerId,
    });
    const createdByOperation = !before.mounted;
    try {
      await ensureVolumeBindMount(mountOpts);
    } catch (error) {
      if (createdByOperation) await removeVolumeBindMount(mountOpts);
      throw error;
    }
    return { ok: true, createdByOperation };
  },
  async compensate(ctx, out, prior) {
    if (!out.createdByOperation) return;
    const { service, instance } = loadRows(ctx.input);
    const server = db.getServer(targetFrom(prior).targetServerId);
    if (!server || !instance.volume_mount) return;
    await removeVolumeBindMount({
      serverIp: server.ipv4,
      hostKey: server.ssh_host_key || undefined,
      hostMountPath: instance.volume_mount.split(":")[0],
      blockName: `svc-${service.id}`,
    });
  },
};

const convergeContainer: Step<RepairServiceInput, { containerId: string }> = {
  name: "converge_container",
  label: "Run repaired container",
  async run(ctx, prior) {
    const { service, instance, catalog } = loadRows(ctx.input);
    const server = db.getServer(targetFrom(prior).targetServerId);
    if (!server) throw new Error("Repair target server disappeared");
    try {
      return await pullAndRunService(server.ipv4, {
        name: instance.container_name,
        image: resolveServiceImage(catalog, service.version),
        port: service.port,
        hostPort: reservationFrom(prior).hostPort,
        envVars: JSON.parse(service.env_vars || "{}") as Record<string, string>,
        volumeMount: instance.volume_mount || undefined,
        bindAddress: replicaBindHost(server),
        cmd: catalog.cmd,
        memoryMb: catalog.memoryMb,
        cpus: catalog.cpus,
        extraCaps: catalog.extraCaps,
      }, server.ssh_host_key || undefined);
    } catch (error) {
      // pullAndRunService removes the old named container before docker run;
      // if docker run partially succeeded, this step cannot rely on engine
      // compensation because it has not completed yet.
      try { await removeContainer(server.ipv4, instance.container_name, server.ssh_host_key || undefined); } catch { /* best effort */ }
      throw error;
    }
  },
  async compensate(ctx, _out, prior) {
    const { instance } = loadRows(ctx.input);
    const server = db.getServer(targetFrom(prior).targetServerId);
    if (!server) return;
    await removeContainer(server.ipv4, instance.container_name, server.ssh_host_key || undefined);
  },
};

const verifyHealth: Step<RepairServiceInput, HealthOut> = {
  name: "verify_health",
  label: "Verify repaired service",
  async run(ctx, prior) {
    const { instance, catalog } = loadRows(ctx.input);
    const server = db.getServer(targetFrom(prior).targetServerId);
    if (!server) return { healthy: false, error: "Repair target server disappeared" };
    const health = await serviceHealthCheck(
      server.ipv4,
      instance.container_name,
      catalog.healthCmd,
      10,
      server.ssh_host_key || undefined,
    );
    return { healthy: health.healthy, error: health.error };
  },
};

const commitPlacement: Step<RepairServiceInput, { moved: boolean }> = {
  name: "commit_placement",
  label: "Commit repaired placement",
  async run(ctx, prior) {
    const health = prior["verify_health"] as HealthOut | undefined;
    if (!health?.healthy) {
      db.updateServiceInstanceStatus(ctx.input.instanceId, "unhealthy");
      db.updateServiceStatus(ctx.input.serviceId, "unhealthy");
      throw new Error(health?.error || "Repaired service did not become healthy");
    }
    const target = targetFrom(prior);
    if (target.moving) {
      db.updateServiceInstancePlacement(
        ctx.input.instanceId,
        target.targetServerId,
        reservationFrom(prior).hostPort,
      );
    }
    return { moved: target.moving };
  },
  async compensate(ctx, out, prior) {
    if (!out.moved) return;
    const target = targetFrom(prior);
    db.updateServiceInstancePlacement(ctx.input.instanceId, target.sourceServerId, target.sourceHostPort);
  },
};

const markRunning: Step<RepairServiceInput, { ok: true }> = {
  name: "mark_running",
  label: "Mark service running",
  async run(ctx) {
    db.updateServiceInstanceStatus(ctx.input.instanceId, "running");
    db.updateServiceStatus(ctx.input.serviceId, "running");
    return { ok: true };
  },
};

const releaseReservation: Step<RepairServiceInput, { ok: true }> = {
  name: "release_port_reservation",
  label: "Release port reservation",
  async run(ctx) {
    try {
      db.releaseHostPortReservations("service-repair", String(ctx.opId));
    } catch (error) {
      ctx.log(`Port reservation cleanup warning: ${error}`);
    }
    return { ok: true };
  },
  async probe(ctx) {
    // Releasing a missing reservation is a no-op. Always converge here; a
    // completed prior step is still durably skipped by the runner.
    try {
      db.releaseHostPortReservations("service-repair", String(ctx.opId));
    } catch {
      return null;
    }
    return { ok: true };
  },
};

const gcSource: Step<RepairServiceInput, { ok: true; skipped?: boolean }> = {
  name: "gc_source_server",
  label: "GC empty source server",
  async run(ctx, prior) {
    const target = targetFrom(prior);
    if (!target.moving) return { ok: true, skipped: true };
    try {
      await db.gcServerIfEmpty(target.sourceServerId);
    } catch (error) {
      ctx.log(`gcServerIfEmpty(${target.sourceServerId}) failed: ${error}`);
    }
    return { ok: true };
  },
};

const repairServiceOp: OpKindDefinition<RepairServiceInput> = {
  kind: "repair_service",
  label: "Repair service",
  resourceKeys: (input) => {
    const instance = db.getServiceInstance(input.instanceId);
    const service = db.getService(input.serviceId);
    const candidates = service
      ? db.getServers().filter((server) => server.pool === (service.placement_pool || "general"))
      : [];
    return [
      `service:${input.serviceId}`,
      ...new Set([
        ...(instance ? [instance.server_id] : []),
        ...candidates.map((server) => server.id),
      ].map((id) => `server:${id}`)),
      ...(instance?.volume_id ? [`volume:${instance.volume_id}`] : []),
    ];
  },
  steps: [
    selectRepairTarget,
    inspectVolume,
    markDeploying,
    reserveTargetPort,
    verifyTargetPort,
    attachVolume,
    ensureBindMount,
    convergeContainer,
    verifyHealth,
    commitPlacement,
    markRunning,
    releaseReservation,
    gcSource,
  ],
};

registerOp(repairServiceOp as OpKindDefinition<any>);
export default repairServiceOp;
export type { RepairServiceInput };
