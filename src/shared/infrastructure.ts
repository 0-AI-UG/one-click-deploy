import type { ServerRow } from "./db/servers.ts";
import {
  getInfrastructureProvider,
  requireInfrastructureProvider,
  type InfrastructureProvider,
  type VolumeProvider,
} from "./providers/index.ts";
import { assignedProvider } from "./provider-connections.ts";

export type ServerProvider = string;
export type ServerOwnership = "managed" | "connected";

export type ServerCapabilities = {
  providerLifecycle: boolean;
  providerVolumes: boolean;
  providerNetwork: boolean;
  providerFirewall: boolean;
};

/** The deliberately small provider boundary used by scheduling and lifecycle
 * code. It describes what OCD may do, not every feature a cloud might expose. */
export function serverCapabilities(
  server: Pick<ServerRow, "provider" | "ownership">,
): ServerCapabilities {
  const provider = server.ownership === "managed"
    ? getInfrastructureProvider(server.provider)
    : null;
  return {
    providerLifecycle: !!provider?.capabilities.compute,
    providerVolumes: !!provider?.capabilities.volumes,
    providerNetwork: !!provider?.capabilities.privateNetwork,
    providerFirewall: !!provider?.capabilities.firewall,
  };
}

export function isManagedServer(
  server: Pick<ServerRow, "provider" | "ownership">,
): boolean {
  return serverCapabilities(server).providerLifecycle;
}

export function infrastructureProviderForServer(
  server: Pick<ServerRow, "name" | "provider" | "ownership">,
): InfrastructureProvider {
  if (server.ownership !== "managed") {
    throw new Error(`Server ${server.name} is operator-owned and has no infrastructure provider`);
  }
  return requireInfrastructureProvider(server.provider);
}

export function defaultInfrastructureProvider(
  settings: Record<string, string>,
): InfrastructureProvider | null {
  const connection = assignedProvider("infrastructure", settings);
  return connection ? getInfrastructureProvider(connection.kind) : null;
}

export function requireDefaultInfrastructureProvider(
  settings: Record<string, string>,
): InfrastructureProvider {
  const connection = assignedProvider("infrastructure", settings);
  if (!connection) {
    throw new Error("No infrastructure provisioner selected; connect a host or configure an optional provider");
  }
  return requireInfrastructureProvider(connection.kind);
}

export function requireProviderVolumes(provider: InfrastructureProvider): VolumeProvider {
  if (!provider.volumes) {
    throw new Error(`Infrastructure provider "${provider.name}" does not support block volumes`);
  }
  return provider.volumes;
}
