export type ProviderId = "hetzner" | "digitalocean" | "vultr" | "lightsail";

// --- Normalized resource types (provider-agnostic) ---

export type ProviderServer = {
  providerId: string;
  ipv4: string;
  ipv6: string;
  /** Private network IPv4 assigned by the provider at create time. Empty
   *  string when the provider doesn't implement private networking or the
   *  server isn't attached. */
  privateIpv4?: string;
  status: string;
};

export type ProviderVolume = {
  providerId: string;
  linuxDevice: string;
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

// --- Private network capability ---

export interface NetworkOps {
  /** Ensure the shared private network exists. Returns its provider id. */
  ensure(): Promise<{ id: string }>;
  /** Attach a server to the network. Idempotent — already-attached is OK. */
  attachServer(serverId: string, networkId: string): Promise<void>;
  /** Read back the server's private IPv4 on the given network. Empty string
   *  if the attachment hasn't settled yet. */
  getPrivateIpv4(serverId: string, networkId: string): Promise<string>;
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
    networkId?: string;
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
    /** Private network to attach at create time — when set, the returned
     *  ProviderServer.privateIpv4 reflects the assigned address. */
    networkId?: string;
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
  snapshots?: SnapshotOps;
  networks?: NetworkOps;
  getPricing?(): Promise<{
    currency: string;
    servers: Record<string, number>;
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
