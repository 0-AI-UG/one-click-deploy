import {
  registerComputeProvider,
  registerDnsProvider,
} from "./registry.ts";
import { hetznerCompute, hetznerDns } from "./hetzner.ts";
import { digitaloceanCompute, digitaloceanDns } from "./digitalocean.ts";

// Register built-in providers
registerComputeProvider(hetznerCompute);
registerDnsProvider(hetznerDns);
registerComputeProvider(digitaloceanCompute);
registerDnsProvider(digitaloceanDns);

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
