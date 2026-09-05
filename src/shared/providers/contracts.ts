import type { ProviderServer, ServerType, TokenValidation, VolumeInfo } from "./types.ts";

export type ProviderCapabilities = {
  compute: boolean;
  volumes: boolean;
  privateNetwork: boolean;
  firewall: boolean;
};

export type ProviderVolume = {
  providerId: string;
  linuxDevice: string;
};

export interface VolumeProvider {
  create(opts: {
    name: string;
    sizeGb: number;
    serverId: string;
    location: string;
  }): Promise<ProviderVolume>;
  get(volumeId: string): Promise<VolumeInfo>;
  list(): Promise<VolumeInfo[]>;
  attach(volumeId: string, serverId: string): Promise<void>;
  detach(volumeId: string): Promise<void>;
  resize(volumeId: string, sizeGb: number): Promise<void>;
  rename(volumeId: string, name: string): Promise<void>;
  delete(volumeId: string): Promise<void>;
}

export interface NetworkProvider {
  ensure(): Promise<{ id: string }>;
  attachServer(serverId: string, networkId: string): Promise<void>;
  getPrivateIpv4(serverId: string, networkId: string): Promise<string>;
}

/**
 * Internal provider boundary. It deliberately models only infrastructure that
 * OCD owns. SSH/Docker application delivery is part of the provider-neutral
 * runtime and must not be implemented by a cloud adapter.
 */
export interface InfrastructureProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  validateToken(token: string): TokenValidation;
  verifyToken(token: string): Promise<void>;
  ensureSshKey(name: string, publicKey: string): Promise<{ id: string; name: string }>;
  ensureFirewall(): Promise<string>;
  ensureFirewallAttached(firewallId: string, serverId: string): Promise<void>;
  listServerTypes(): Promise<ServerType[]>;
  createServer(opts: {
    name: string;
    serverType: string;
    location: string;
    sshKeyName: string;
    firewallId: string;
    userData: string;
    networkId?: string;
  }): Promise<ProviderServer>;
  getServer(providerId: string): Promise<ProviderServer>;
  waitForRunning(providerId: string, onStatus?: (message: string) => void): Promise<void>;
  deleteServer(providerId: string): Promise<void>;
  listServers(): Promise<Array<ProviderServer & { name: string; type: string; location: string }>>;
  readonly volumes?: VolumeProvider;
  readonly networks?: NetworkProvider;
  getPricing(): Promise<{
    currency: string;
    servers: Record<string, number>;
    volumePerGbMonth: number | null;
  } | null>;
}
