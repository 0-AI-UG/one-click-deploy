import { StorageBindingsSchema, type StorageBindings } from "./storage-schema.ts";
export { StorageBindingsSchema, type StorageBindings };
import { createHash, randomBytes } from "node:crypto";
import * as db from "./db.ts";
import { storageConnection } from "./provider-connections.ts";
import { encryptValue, decryptValue } from "./secret-store.ts";
import { getS3Credentials, listBuckets, validateBucketName } from "../engine/object-storage/s3.ts";
import { validObjectKey } from "../engine/object-storage/presign.ts";

export type StorageMethod = "GET" | "HEAD" | "PUT" | "DELETE" | "LIST";
export type StorageGrant = {
  id: string; app: string; providerId: string; endpoint: string; region: string;
  bucket: string; prefix: string; methods: StorageMethod[]; tokenHash: string; createdAt: string;
  appId?: number; binding?: string; specKey?: string; encrypted_value?: string; iv?: string;
};
const GRANTS = "object_storage_grants";
const bindingsKey = (id: number) => `app_storage_bindings.${id}`;
export const getStorageGrants = (): StorageGrant[] => JSON.parse(db.getSettings()[GRANTS] || "[]");
export const saveStorageGrants = (grants: StorageGrant[]) => db.saveSetting(GRANTS, JSON.stringify(grants));
export const getAppStorage = (id: number): StorageBindings => JSON.parse(db.getSettings()[bindingsKey(id)] || "{}");
export function saveAppStorage(id: number, bindings: StorageBindings, initial = false): void {
  const value = JSON.stringify(bindings);
  if (JSON.stringify(getAppStorage(id)) === value) return;
  db.default.transaction(() => {
    db.saveSetting(bindingsKey(id), value);
    if (!initial) db.default.query("UPDATE apps SET config_revision = config_revision + 1 WHERE id = ?").run(id);
  })();
}
export const storageTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const specKey = (binding: StorageBindings[string]) => storageTokenHash(JSON.stringify(binding));
export function resolveStorageBindings(input: StorageBindings = {}, previous: StorageBindings = {}): StorageBindings {
  const parsed = StorageBindingsSchema.parse(input);
  return Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
    const connection = storageConnection(value.connection ?? previous[name]?.connection);
    if (!connection) throw new Error(`Select an object storage connection for ${name}`);
    return [name, { connection: connection.id, bucket: value.bucket, prefix: value.prefix, permissions: [...new Set(value.permissions)].sort(), generation: value.generation ?? 0 }];
  }));
}
export function storageVariableNames(name: string): { token: string; url: string } {
  const prefix = name === "primary" ? "OCD_STORAGE" : `OCD_${name.toUpperCase()}_STORAGE`;
  return { token: `${prefix}_TOKEN`, url: `${prefix}_URL` };
}
export function storageAuthorizationUrl(): string {
  const domain = db.getPanel()?.domain;
  if (!domain) throw new Error("Panel HTTPS domain is required for object storage bindings");
  return `https://${domain}/api/storage/authorize`;
}
function methodsFor(permissions: StorageBindings[string]["permissions"]): StorageMethod[] {
  return permissions.flatMap<StorageMethod>(p => p === "read" ? ["GET", "HEAD"] : p === "write" ? ["PUT"] : p === "delete" ? ["DELETE"] : ["LIST"]);
}
/** Prepare replacement grants before a rollout; current grants stay usable until all replicas attest. */
export async function prepareStorageBindings(app: { id: number; name: string }, bindings: StorageBindings): Promise<void> {
  if (Object.keys(bindings).length) storageAuthorizationUrl();
  const owner = db.getApp(app.id);
  if (owner) {
    const family = db.getApps().filter(other => other.id !== owner.id &&
      (other.id === owner.target_of || other.target_of === owner.id || (owner.target_of && other.target_of === owner.target_of)) &&
      (other.target || "production") !== (owner.target || "production"));
    for (const relative of family) for (const destination of Object.values(getAppStorage(relative.id))) {
      if (Object.values(bindings).some(b => b.connection === destination.connection && b.bucket === destination.bucket &&
        (b.prefix.startsWith(destination.prefix) || destination.prefix.startsWith(b.prefix)))) {
        throw new Error(`Storage scope overlaps ${relative.name}; select a separate bucket or prefix for each deploy target`);
      }
    }
  }
  for (const [name, spec] of Object.entries(bindings)) {
    const connection = storageConnection(spec.connection);
    if (!connection) throw new Error(`Storage connection missing for ${name}`);
    const current = getStorageGrants().find(g => g.appId === app.id && g.binding === name && g.specKey === specKey(spec));
    if (current && current.endpoint === connection.config.endpoint && current.region === connection.config.region) continue;
    const credentials = await getS3Credentials(connection.id);
    if (!credentials || !(await listBuckets(credentials)).some(b => b.name === spec.bucket)) throw new Error(`Storage binding ${name}: bucket unavailable on ${connection.name}`);
    const token = `ocds_${randomBytes(32).toString("hex")}`;
    const encrypted = await encryptValue(token);
    const grants = getStorageGrants();
    // Another preparation may have completed during provider I/O.
    if (grants.some(g => g.appId === app.id && g.binding === name && g.specKey === specKey(spec) && g.endpoint === credentials.endpoint && g.region === credentials.region)) continue;
    saveStorageGrants([...grants, { id: crypto.randomUUID(), app: app.name, appId: app.id, binding: name, specKey: specKey(spec),
      providerId: connection.id, endpoint: credentials.endpoint, region: credentials.region, bucket: spec.bucket, prefix: spec.prefix,
      methods: methodsFor(spec.permissions), tokenHash: storageTokenHash(token), createdAt: new Date().toISOString(), ...encrypted }]);
  }
}
export async function appStorageEnv(appId: number, bindings = getAppStorage(appId)): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, spec] of Object.entries(bindings)) {
    const connection = storageConnection(spec.connection);
    const grant = getStorageGrants().find(g => g.appId === appId && g.binding === name && g.specKey === specKey(spec) && g.endpoint === connection?.config.endpoint && g.region === connection?.config.region);
    if (!grant?.encrypted_value || !grant.iv) throw new Error(`Storage binding ${name} needs a deployment`);
    const names = storageVariableNames(name);
    result[names.token] = await decryptValue(grant.encrypted_value, grant.iv);
    result[names.url] = storageAuthorizationUrl();
  }
  return result;
}
export function appStorageView(appId: number) {
  return Object.entries(getAppStorage(appId)).map(([name, spec]) => ({ name, ...spec,
    connection_name: storageConnection(spec.connection)?.name ?? spec.connection,
    variables: storageVariableNames(name), injected_by: "Object storage",
  }));
}
/** Call only after every live replica attests to the desired environment. */
export function retireAppStorageGrants(appId: number): void {
  const desired = getAppStorage(appId);
  const before = getStorageGrants();
  const after = before.filter(g => g.appId !== appId || (g.binding && desired[g.binding] && g.specKey === specKey(desired[g.binding])));
  if (after.length !== before.length) saveStorageGrants(after);
}
export function deleteAppStorage(appId: number): void {
  saveStorageGrants(getStorageGrants().filter(g => g.appId !== appId));
  saveAppStorage(appId, {});
}
export function storageConnectionReferences(id: string): string[] {
  const refs = getStorageGrants().filter(g => g.providerId === id).map(g => `grant for ${g.app}${g.binding ? `/${g.binding}` : ""}`);
  for (const app of db.getApps()) if (Object.values(getAppStorage(app.id)).some(b => b.connection === id)) refs.push(`app ${app.name}`);
  const settings = db.getSettings();
  if (settings.panel_backup_enabled === "1" && settings.panel_backup_connection === id) refs.push("panel backup schedule");
  if (db.default.query("SELECT 1 FROM panel_backups WHERE connection_id=? AND status IN ('pending','running') LIMIT 1").get(id)) refs.push("pending panel backup");
  return [...new Set(refs)];
}
