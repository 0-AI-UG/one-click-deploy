import type { ComputeProvider, DnsProvider, ProviderId } from "./types.ts";

const computeProviders = new Map<ProviderId, ComputeProvider>();
const dnsProviders = new Map<string, DnsProvider>();

export function registerComputeProvider(provider: ComputeProvider): void {
  computeProviders.set(provider.id, provider);
}

export function registerDnsProvider(provider: DnsProvider): void {
  dnsProviders.set(provider.id, provider);
}

export function getComputeProvider(id?: ProviderId | string): ComputeProvider {
  const resolved = (id as ProviderId) ?? getDefaultComputeProviderId();
  const provider = computeProviders.get(resolved);
  if (!provider)
    throw new Error(`Compute provider "${resolved}" not registered`);
  return provider;
}

export function getDnsProvider(id?: string): DnsProvider {
  const resolved = id ?? getDefaultDnsProviderId();
  const provider = dnsProviders.get(resolved);
  if (!provider) throw new Error(`DNS provider "${resolved}" not registered`);
  return provider;
}

export function listComputeProviders(): ComputeProvider[] {
  return [...computeProviders.values()];
}

export function listDnsProviders(): DnsProvider[] {
  return [...dnsProviders.values()];
}

let _getSettings: (() => Record<string, string>) | null = null;

function lazyGetSettings(): Record<string, string> {
  if (!_getSettings) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _getSettings = require("../db.ts").getSettings;
  }
  return _getSettings!();
}

function getDefaultComputeProviderId(): ProviderId {
  return (lazyGetSettings().compute_provider as ProviderId) || "hetzner";
}

function getDefaultDnsProviderId(): string {
  return lazyGetSettings().dns_provider || "hetzner-dns";
}
