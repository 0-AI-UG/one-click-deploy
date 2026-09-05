import * as db from "./db.ts";

export type ProviderUse = "infrastructure" | "object_storage";
export type ProviderKind = "hetzner" | "s3-compatible";

export type ProviderConnection = {
  id: string;
  kind: ProviderKind;
  name: string;
  config: Record<string, string>;
  created_at: string;
  provisioningDefaults?: { serverType: string; location: string };
};

export type ProviderAssignments = Record<ProviderUse, string>;

export type ProviderField = {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  secret?: boolean;
};

export type ProviderCatalogEntry = {
  kind: ProviderKind;
  name: string;
  description: string;
  capabilities: ProviderUse[];
  fields: ProviderField[];
};

export const PROVIDER_CONNECTIONS_SETTING = "provider_connections";
export const PROVIDER_ASSIGNMENTS_SETTING = "provider_assignments";

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    kind: "hetzner",
    name: "Hetzner Cloud",
    description: "Managed servers, private networking, firewalls, and block volumes.",
    capabilities: ["infrastructure"],
    fields: [
      {
        key: "api_token",
        label: "API token",
        type: "password",
        placeholder: "Hetzner Cloud API token",
        secret: true,
      },
    ],
  },
  {
    kind: "s3-compatible",
    name: "S3-compatible object storage",
    description: "Amazon S3, Hetzner Object Storage, MinIO, and other SigV4-compatible services.",
    capabilities: ["object_storage"],
    fields: [
      { key: "endpoint", label: "Endpoint", type: "url", placeholder: "https://s3.example.com" },
      { key: "region", label: "Signing region", type: "text", placeholder: "us-east-1" },
      { key: "access_key", label: "Access key", type: "password", secret: true },
      { key: "secret_key", label: "Secret key", type: "password", secret: true },
    ],
  },
];

const EMPTY_ASSIGNMENTS: ProviderAssignments = {
  infrastructure: "",
  object_storage: "",
};

export function providerCatalogEntry(kind: string): ProviderCatalogEntry | null {
  return PROVIDER_CATALOG.find((entry) => entry.kind === kind) ?? null;
}

export function parseProviderConnections(raw: string | undefined): ProviderConnection[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ProviderConnection => {
      return !!item && typeof item === "object" &&
        typeof item.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) &&
        !!providerCatalogEntry(item.kind) && typeof item.name === "string" &&
        !!item.config && typeof item.config === "object" && typeof item.created_at === "string";
    });
  } catch {
    return [];
  }
}

export function parseProviderAssignments(raw: string | undefined): ProviderAssignments {
  if (!raw) return { ...EMPTY_ASSIGNMENTS };
  try {
    const value = JSON.parse(raw) as Partial<ProviderAssignments>;
    return {
      infrastructure: typeof value.infrastructure === "string" ? value.infrastructure : "",
      object_storage: typeof value.object_storage === "string" ? value.object_storage : "",
    };
  } catch {
    return { ...EMPTY_ASSIGNMENTS };
  }
}

export function getProviderConnections(settings = db.getSettings()): ProviderConnection[] {
  return parseProviderConnections(settings[PROVIDER_CONNECTIONS_SETTING]);
}

export function saveProviderConnections(connections: ProviderConnection[]): void {
  db.saveSetting(PROVIDER_CONNECTIONS_SETTING, JSON.stringify(connections));
}

export function getProviderAssignments(settings = db.getSettings()): ProviderAssignments {
  return parseProviderAssignments(settings[PROVIDER_ASSIGNMENTS_SETTING]);
}

export function saveProviderAssignments(assignments: ProviderAssignments): void {
  const current = getProviderAssignments();
  if (current.infrastructure !== assignments.infrastructure) {
    const settings = db.getSettings();
    const connections = getProviderConnections(settings);
    const previous = connections.find((connection) => connection.id === current.infrastructure);
    if (previous) {
      previous.provisioningDefaults = {
        serverType: settings.default_server_type || "",
        location: settings.default_location || "",
      };
      saveProviderConnections(connections);
    }
    const next = connections.find((connection) => connection.id === assignments.infrastructure);
    // Keep the active projection for runtime/CLI consumers of these settings.
    db.saveSetting("default_server_type", next?.provisioningDefaults?.serverType || "");
    db.saveSetting("default_location", next?.provisioningDefaults?.location || "");
  }
  db.saveSetting(PROVIDER_ASSIGNMENTS_SETTING, JSON.stringify(assignments));
}

export function assignedProvider(
  use: ProviderUse,
  settings = db.getSettings(),
): ProviderConnection | null {
  const id = getProviderAssignments(settings)[use];
  return id ? getProviderConnections(settings).find((provider) => provider.id === id) ?? null : null;
}

export function providerSecretKey(connectionId: string, field: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(connectionId) || !/^[a-z][a-z0-9_]*$/.test(field)) {
    throw new Error("Invalid provider credential key");
  }
  return `provider.${connectionId}.${field}`;
}

export function newProviderConnectionId(kind: ProviderKind): string {
  return `${kind.replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}
