import {
  registerComputeProvider,
  registerDnsProvider,
} from "./registry.ts";
import { hetznerCompute, hetznerDns } from "./hetzner.ts";

// Register built-in providers
registerComputeProvider(hetznerCompute);
registerDnsProvider(hetznerDns);

// Re-export the public API
export {
  getComputeProvider,
  getDnsProvider,
  listComputeProviders,
  listDnsProviders,
} from "./registry.ts";

export type {
  ComputeProvider,
  DnsProvider,
  ProviderId,
  ServerType,
  DnsZone,
  ProviderServer,
  ProviderVolume,
  VolumeOps,
  NetworkOps,
  SnapshotOps,
  SnapshotInfo,
  SnapshotListItem,
} from "./types.ts";
