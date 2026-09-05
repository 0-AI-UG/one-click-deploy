import { hetzner } from "./hetzner.ts";
import { registerInfrastructureProvider } from "./registry.ts";

// Cloud integrations are optional adapters. Application delivery never reads
// this registry: only managed-infrastructure workflows do.
registerInfrastructureProvider(hetzner);

export { hetzner } from "./hetzner.ts";
export type { Hetzner } from "./hetzner.ts";
export {
  getInfrastructureProvider,
  requireInfrastructureProvider,
  listInfrastructureProviders,
  __replaceInfrastructureProvidersForTest,
} from "./registry.ts";
export type {
  InfrastructureProvider,
  NetworkProvider,
  ProviderCapabilities,
  VolumeProvider,
} from "./contracts.ts";

export type {
  ServerType,
  ProviderServer,
  ProviderVolume,
  VolumeInfo,
  TokenValidation,
} from "./types.ts";
