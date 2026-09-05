import { corsHeaders } from "../lib/cors.ts";
import { requireAdmin } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { maskToken, secretStore } from "../../shared/secret-store.ts";
import { getInfrastructureProvider } from "../../shared/providers/index.ts";
import {
  PROVIDER_CATALOG,
  getProviderAssignments,
  getProviderConnections,
  newProviderConnectionId,
  providerCatalogEntry,
  providerSecretKey,
  saveProviderAssignments,
  saveProviderConnections,
  type ProviderAssignments,
  type ProviderConnection,
  type ProviderKind,
  type ProviderUse,
} from "../../shared/provider-connections.ts";
import { isS3Endpoint, isS3Region, listBuckets } from "../../engine/object-storage/s3.ts";

type ProviderInput = {
  kind?: string;
  name?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
};

function jsonError(error: string, status = 400): Response {
  return Response.json({ error }, { status, headers: corsHeaders });
}

function providerInputError(error: unknown): Response {
  if (error instanceof Error && ["AuthError", "ForbiddenError", "PermissionError"].includes(error.constructor.name)) {
    return handleError(error);
  }
  return jsonError(error instanceof Error ? error.message : "Invalid provider configuration");
}

function isMasked(value: string): boolean {
  return value === "****" || value.includes("...");
}

function cleanConfig(kind: ProviderKind, raw: Record<string, unknown> = {}): Record<string, string> {
  if (kind === "hetzner") return {};
  const endpoint = String(raw.endpoint ?? "").trim().replace(/\/$/, "");
  const region = String(raw.region ?? "").trim();
  if (!isS3Endpoint(endpoint)) throw new Error("Endpoint must be an HTTPS origin");
  if (!isS3Region(region)) throw new Error("Signing region must be a valid AWS region identifier");
  return { endpoint, region };
}

async function finalCredentials(
  id: string,
  kind: ProviderKind,
  raw: Record<string, unknown> = {},
  existing = false,
): Promise<Record<string, string>> {
  const catalog = providerCatalogEntry(kind)!;
  const result: Record<string, string> = {};
  for (const field of catalog.fields.filter((candidate) => candidate.secret)) {
    const submitted = String(raw[field.key] ?? "").trim();
    const prior = existing ? await secretStore.get(providerSecretKey(id, field.key)) ?? "" : "";
    result[field.key] = !submitted || isMasked(submitted) ? prior : submitted;
    if (!result[field.key]) throw new Error(`${field.label} is required`);
  }
  return result;
}

async function verifyProvider(
  kind: ProviderKind,
  config: Record<string, string>,
  credentials: Record<string, string>,
): Promise<void> {
  if (kind === "hetzner") {
    const adapter = getInfrastructureProvider(kind);
    if (!adapter) throw new Error("Hetzner infrastructure adapter is not installed");
    const validation = adapter.validateToken(credentials.api_token);
    if (!validation.valid) throw new Error(`${adapter.name} API token: ${validation.error}`);
    await adapter.verifyToken(credentials.api_token);
    return;
  }
  await listBuckets({
    endpoint: config.endpoint,
    region: config.region,
    accessKey: credentials.access_key,
    secretKey: credentials.secret_key,
  });
}

async function providerView(provider: ProviderConnection) {
  const catalog = providerCatalogEntry(provider.kind)!;
  const credentials: Record<string, string> = {};
  let configured = true;
  for (const field of catalog.fields.filter((candidate) => candidate.secret)) {
    const value = await secretStore.get(providerSecretKey(provider.id, field.key)) ?? "";
    credentials[field.key] = maskToken(value);
    configured = configured && !!value;
  }
  return {
    ...provider,
    capabilities: catalog.capabilities,
    credentials,
    configured,
  };
}

export async function handleGetProviders(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const providers = await Promise.all(getProviderConnections().map(providerView));
    return Response.json({ catalog: PROVIDER_CATALOG, providers, assignments: getProviderAssignments() }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateProvider(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = await request.json() as ProviderInput;
    const catalog = providerCatalogEntry(String(body.kind ?? ""));
    if (!catalog) return jsonError("Unknown provider type");
    const kind = catalog.kind;
    const connections = getProviderConnections();
    if (catalog.capabilities.includes("infrastructure") && connections.some((provider) => provider.kind === kind)) {
      return jsonError(`Only one ${catalog.name} connection can manage infrastructure`, 409);
    }
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 80) return jsonError("Provider name must be between 1 and 80 characters");
    const id = newProviderConnectionId(kind);
    const config = cleanConfig(kind, body.config);
    const credentials = await finalCredentials(id, kind, body.credentials);
    await verifyProvider(kind, config, credentials);
    for (const [field, value] of Object.entries(credentials)) {
      await secretStore.set(providerSecretKey(id, field), value);
    }
    const provider: ProviderConnection = { id, kind, name, config, created_at: new Date().toISOString() };
    saveProviderConnections([...connections, provider]);

    const assignments = getProviderAssignments();
    for (const capability of catalog.capabilities) {
      if (!assignments[capability]) assignments[capability] = id;
    }
    saveProviderAssignments(assignments);
    return Response.json({ provider: await providerView(provider), assignments }, { status: 201, headers: corsHeaders });
  } catch (error) {
    return providerInputError(error);
  }
}

export async function handleUpdateProvider(request: Request, providerId: string): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = await request.json() as ProviderInput;
    const connections = getProviderConnections();
    const index = connections.findIndex((provider) => provider.id === providerId);
    if (index < 0) return jsonError("Provider not found", 404);
    const current = connections[index];
    const name = String(body.name ?? current.name).trim();
    if (!name || name.length > 80) return jsonError("Provider name must be between 1 and 80 characters");
    const config = cleanConfig(current.kind, body.config ?? current.config);
    const credentials = await finalCredentials(current.id, current.kind, body.credentials, true);
    await verifyProvider(current.kind, config, credentials);
    for (const [field, value] of Object.entries(credentials)) {
      await secretStore.set(providerSecretKey(current.id, field), value);
    }
    const updated = { ...current, name, config };
    connections[index] = updated;
    saveProviderConnections(connections);
    return Response.json({ provider: await providerView(updated) }, { headers: corsHeaders });
  } catch (error) {
    return providerInputError(error);
  }
}

export async function handleDeleteProvider(request: Request, providerId: string): Promise<Response> {
  try {
    await requireAdmin(request);
    const connections = getProviderConnections();
    const provider = connections.find((candidate) => candidate.id === providerId);
    if (!provider) return jsonError("Provider not found", 404);
    const assignments = getProviderAssignments();
    const assignedUses = (Object.entries(assignments) as Array<[ProviderUse, string]>)
      .filter(([, id]) => id === providerId).map(([use]) => use);
    if (assignedUses.length) {
      return jsonError(`Provider is still assigned to: ${assignedUses.join(", ")}`, 409);
    }
    const catalog = providerCatalogEntry(provider.kind)!;
    for (const field of catalog.fields.filter((candidate) => candidate.secret)) {
      await secretStore.delete(providerSecretKey(provider.id, field.key));
    }
    saveProviderConnections(connections.filter((candidate) => candidate.id !== providerId));
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleSaveProviderAssignments(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = await request.json() as Partial<ProviderAssignments>;
    const current = getProviderAssignments();
    const assignments: ProviderAssignments = {
      infrastructure: String(body.infrastructure ?? current.infrastructure).trim(),
      object_storage: String(body.object_storage ?? current.object_storage).trim(),
    };
    const connections = getProviderConnections();
    for (const [use, id] of Object.entries(assignments) as Array<[ProviderUse, string]>) {
      if (!id) continue;
      const provider = connections.find((candidate) => candidate.id === id);
      if (!provider || !providerCatalogEntry(provider.kind)?.capabilities.includes(use)) {
        return jsonError(`Selected provider does not support ${use}`);
      }
    }
    if (assignments.infrastructure !== current.infrastructure && db.getServers().some((server) => server.ownership === "managed")) {
      return jsonError("Cannot change the infrastructure provider while managed servers exist", 409);
    }
    saveProviderAssignments(assignments);
    return Response.json({ ok: true, assignments }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
