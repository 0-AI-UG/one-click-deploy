export type ProviderId = "hetzner" | "digitalocean" | "vultr" | "lightsail";

// --- Normalized resource types (provider-agnostic) ---

export type ProviderServer = {
  providerId: string;
  ipv4: string;
  ipv6: string;
  status: string;
};

export type ProviderVolume = {
  providerId: string;
  linuxDevice: string;
};

export type ProviderLoadBalancer = {
  providerId: string;
  ipv4: string;
};

export type ProviderCertificate = {
  providerId: string;
};

export type ServerType = {
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  locations: string[];
};

export type DnsZone = {
  id: string;
  name: string;
};

// --- Compute provider (required for deploying apps) ---

export type VolumeInfo = {
  providerId: string;
  name: string;
  sizeGb: number;
  location: string;
  serverId: string | null;
};

export interface VolumeOps {
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
  delete(volumeId: string): Promise<void>;
}

export type LoadBalancerInfo = {
  providerId: string;
  name: string;
  ipv4: string;
  type: string;
  location: string;
  labels: Record<string, string>;
  targetCount: number;
};

export interface LoadBalancerOps {
  create(appName: string, location: string): Promise<ProviderLoadBalancer>;
  delete(lbId: string): Promise<void>;
  get(lbId: string): Promise<{
    ipv4: string;
    targets: Array<{ type: string; server?: { id: number } }>;
    services: unknown[];
  }>;
  list(): Promise<LoadBalancerInfo[]>;
  addTarget(lbId: string, serverId: string): Promise<void>;
  removeTarget(lbId: string, serverId: string): Promise<void>;
  addService(
    lbId: string,
    destPort: number,
    certId?: number,
    stickySession?: boolean,
  ): Promise<void>;
  createCertificate(
    appName: string,
    domain: string,
  ): Promise<ProviderCertificate>;
  deleteCertificate(certId: string): Promise<void>;
}

export interface FirewallRuleOps {
  addLBRule(firewallId: string, port: number, lbIpv4: string): Promise<void>;
  removeLBRule(
    firewallId: string,
    port: number,
    lbIpv4: string,
  ): Promise<void>;
}

// --- Snapshot / freeze capability ---
//
// Optional. Providers that don't implement snapshots skip the "deep sleep" path
// in the lifecycle state machine; their apps stay in light sleep (container
// stopped but server still alive).

export type SnapshotInfo = {
  /** "creating" while the provider is still building the image, "available"
   *  once it can be used to boot a new server, "failed" on a terminal error. */
  status: "creating" | "available" | "failed";
  /** Size in GB. May be 0 while status === "creating". */
  sizeGb: number;
};

export type SnapshotListItem = {
  snapshotId: string;
  description: string;
  sizeGb: number;
  status: "creating" | "available" | "failed";
};

export interface SnapshotOps {
  /**
   * Issue a snapshot of the given server's system disk. Returns once the job
   * has been accepted and an id has been assigned — the image may still be
   * building. Poll with `get` until status === "available".
   */
  create(
    providerServerId: string,
    description: string,
  ): Promise<{ snapshotId: string }>;
  get(snapshotId: string): Promise<SnapshotInfo>;
  delete(snapshotId: string): Promise<void>;
  /**
   * List every snapshot this account owns that is managed by the panel. Used
   * by the freeze worker to guard against blowing the provider snapshot quota.
   */
  list(): Promise<SnapshotListItem[]>;
  /**
   * Create a new cloud instance from an existing snapshot, in `location`, with
   * `volumeIds` attached at creation time. The SSH key + firewall the provider
   * uses for fresh servers are reused automatically.
   */
  createServerFromSnapshot(opts: {
    name: string;
    snapshotId: string;
    serverType: string;
    location: string;
    sshKeyName: string;
    firewallId: string;
    volumeIds: string[];
  }): Promise<ProviderServer>;
}

export interface ComputeProvider {
  readonly id: ProviderId;
  readonly name: string;

  // SSH key management (upload public key so servers can be created with it)
  ensureSshKey(
    name: string,
    publicKey: string,
  ): Promise<{ id: string; name: string }>;

  // Firewall
  ensureFirewall(): Promise<string>;

  // Server lifecycle
  listServerTypes(): Promise<ServerType[]>;
  createServer(opts: {
    name: string;
    serverType: string;
    location: string;
    sshKeyName: string;
    firewallId: string;
    userData: string;
  }): Promise<ProviderServer>;
  getServer(providerId: string): Promise<ProviderServer>;
  waitForRunning(
    providerId: string,
    onStatus?: (msg: string) => void,
  ): Promise<void>;
  deleteServer(providerId: string): Promise<void>;
  listServers(): Promise<
    Array<ProviderServer & { name: string; type: string; location: string }>
  >;

  // Optional capabilities
  volumes?: VolumeOps;
  loadBalancers?: LoadBalancerOps;
  firewallRules?: FirewallRuleOps;
  snapshots?: SnapshotOps;
  getPricing?(): Promise<{
    currency: string;
    servers: Record<string, number>;
    loadBalancers: Record<string, number>;
    volumePerGbMonth: number | null;
  } | null>;
}

// --- DNS provider (separate from compute) ---

export interface DnsProvider {
  readonly id: string;
  readonly name: string;

  listZones(): Promise<DnsZone[]>;
  createRecord(opts: {
    zoneId: string;
    name: string;
    type: string;
    value: string;
    ttl?: number;
  }): Promise<{ id: string; name: string; type: string; value: string }>;
  deleteRecord(opts: {
    zoneId: string;
    name: string;
    type: string;
    value: string;
  }): Promise<void>;
}
