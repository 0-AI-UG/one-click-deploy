import type { ServerRow } from "./db/servers.ts";

export type ServerProvider = "hetzner" | "external";
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
  const managedHetzner = server.provider === "hetzner" && server.ownership === "managed";
  return {
    providerLifecycle: managedHetzner,
    providerVolumes: managedHetzner,
    providerNetwork: managedHetzner,
    providerFirewall: managedHetzner,
  };
}

export function isManagedHetznerServer(
  server: Pick<ServerRow, "provider" | "ownership">,
): boolean {
  return serverCapabilities(server).providerLifecycle;
}

export function assertProviderVolumesSupported(
  server: Pick<ServerRow, "name" | "provider" | "ownership">,
): void {
  if (!serverCapabilities(server).providerVolumes) {
    throw new Error(
      `Server ${server.name} is externally connected and does not support OCD-managed volumes or managed services`,
    );
  }
}

export function assertConnectedStatelessWorkload(
  server: Pick<ServerRow, "name" | "provider" | "ownership">,
  requested: { managedVolume: boolean; hostMounts: boolean; managedService?: boolean },
): void {
  if (server.ownership !== "connected") return;
  if (requested.managedVolume || requested.hostMounts || requested.managedService) {
    throw new Error(
      `Server ${server.name} is externally connected; only stateless app containers are supported`,
    );
  }
}
