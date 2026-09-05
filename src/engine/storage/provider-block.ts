import type { ServerRow } from "../../shared/db.ts";
import { requireProviderVolumes } from "../../shared/infrastructure.ts";
import { requireInfrastructureProvider } from "../../shared/providers/registry.ts";
import { ensureVolumeBindMount, removeVolumeBindMount } from "../hetzner/host-mounts.ts";
import type { StorageDriver } from "./contracts.ts";

export function providerBlockStorage(providerId: string): StorageDriver {
  const volumes = () => requireProviderVolumes(requireInfrastructureProvider(providerId));
  return {
    id: `${providerId}-block`,
    name: `${providerId} block storage`,
    portable: true,
    supports(server) {
      return server.ownership === "managed" && server.provider === providerId;
    },
    async create({ server, name, sizeGb }) {
      const volume = await volumes().create({
        name,
        sizeGb,
        serverId: server.provider_id,
        location: server.location,
      });
      return {
        id: volume.providerId,
        name,
        sizeGb,
        location: server.location,
        attachedServerId: server.provider_id,
        hostPath: `/mnt/${name}`,
      };
    },
    async inspect(volumeId, server) {
      const volume = await volumes().get(volumeId);
      return {
        id: volume.providerId,
        name: volume.name,
        sizeGb: volume.sizeGb,
        location: volume.location,
        attachedServerId: volume.serverId,
        hostPath: `/mnt/vol-${volume.providerId}`,
      };
    },
    async list(server) {
      const inventory = await volumes().list();
      return inventory.map((volume) => ({
        id: volume.providerId,
        name: volume.name,
        sizeGb: volume.sizeGb,
        location: volume.location,
        attachedServerId: volume.serverId,
        hostPath: `/mnt/vol-${volume.providerId}`,
      }));
    },
    async attach(volumeId, server) {
      await volumes().attach(volumeId, server.provider_id);
    },
    async detach(volumeId, server) {
      await volumes().detach(volumeId);
    },
    async resize(volumeId, sizeGb, server) {
      await volumes().resize(volumeId, sizeGb);
    },
    async rename(volumeId, name, server) {
      await volumes().rename(volumeId, name);
    },
    async delete(volumeId, server) {
      await volumes().delete(volumeId);
    },
    async ensureMount({ server, volumeId, hostPath, blockName }) {
      // Cloud block devices can take a moment to appear after attachment.
      await Bun.sleep(3000);
      await ensureVolumeBindMount({
        serverIp: server.management_address || server.ipv4,
        hostKey: server.ssh_host_key || undefined,
        hetznerVolumeId: volumeId,
        hostMountPath: hostPath,
        blockName,
      });
    },
    async removeMount({ server, hostPath, blockName }) {
      await removeVolumeBindMount({
        serverIp: server.management_address || server.ipv4,
        hostKey: server.ssh_host_key || undefined,
        hostMountPath: hostPath,
        blockName,
      });
    },
  };
}
