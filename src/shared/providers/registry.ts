import type { InfrastructureProvider } from "./contracts.ts";

const providers = new Map<string, InfrastructureProvider>();

export function registerInfrastructureProvider(provider: InfrastructureProvider): void {
  if (!/^[a-z][a-z0-9-]*$/.test(provider.id)) {
    throw new Error(`Invalid infrastructure provider id: ${provider.id}`);
  }
  if (providers.has(provider.id)) {
    throw new Error(`Infrastructure provider already registered: ${provider.id}`);
  }
  providers.set(provider.id, provider);
}

export function getInfrastructureProvider(id: string): InfrastructureProvider | null {
  return providers.get(id) ?? null;
}

export function requireInfrastructureProvider(id: string): InfrastructureProvider {
  if (!id) throw new Error("No infrastructure provisioner selected");
  const provider = getInfrastructureProvider(id);
  if (!provider) throw new Error(`Infrastructure provider is not installed: ${id}`);
  return provider;
}

export function listInfrastructureProviders(): InfrastructureProvider[] {
  return [...providers.values()];
}

/** Test seam. Production registration is static and happens in index.ts. */
export function __replaceInfrastructureProvidersForTest(next: InfrastructureProvider[]): void {
  providers.clear();
  for (const provider of next) registerInfrastructureProvider(provider);
}
