import {
  registerComputeProvider,
  registerDnsProvider,
} from "./registry.ts";
import { hetznerCompute, hetznerDns } from "./hetzner.ts";

// Hetzner Cloud is the only supported provider. The registry abstraction is
// kept as a stable compute/DNS seam (and so tests can swap in fakes), but there
// is intentionally a single registered implementation.
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
} from "./types.ts";
