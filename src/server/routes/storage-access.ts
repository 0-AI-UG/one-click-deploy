import { createHash, randomBytes } from "node:crypto";
import * as db from "../../shared/db.ts";
import { assignedProvider } from "../../shared/provider-connections.ts";
import { getS3Credentials, listBuckets, validateBucketName } from "../../engine/object-storage/s3.ts";
import { presignObject, validObjectKey } from "../../engine/object-storage/presign.ts";
import { requireAdmin } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";

type Method = "GET" | "HEAD" | "PUT" | "DELETE" | "LIST";
type Grant = { id: string; app: string; providerId: string; endpoint: string; region: string; bucket: string; prefix: string;
  methods: Method[]; tokenHash: string; createdAt: string };
const SETTING = "object_storage_grants";
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const grants = (): Grant[] => JSON.parse(db.getSettings()[SETTING] || "[]");
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function authorizeObject(grant: Pick<Grant, "prefix" | "methods">, body: Record<string, unknown>): {
  key: string; method: Exclude<Method, "LIST">; expiresIn: number; contentType?: string; sha256?: string;
} {
  const method = body.method as Exclude<Method, "LIST">;
  if (!grant.methods.includes(method)) throw new Error("Method not allowed");
  if (!validObjectKey(body.key)) throw new Error("Invalid key");
  // Prefix is owned by the grant, never supplied by the caller.
  const key = `${grant.prefix}${body.key}`;
  if (!validObjectKey(key)) throw new Error("Invalid key");
  const expiresIn = body.expiresIn ?? 300;
  if (!Number.isInteger(expiresIn) || Number(expiresIn) < 1 || Number(expiresIn) > 3600) throw new Error("Invalid expiry");
  const contentType = body.contentType;
  if (contentType !== undefined && (method !== "PUT" || typeof contentType !== "string" ||
      contentType.length > 200 || /[\r\n]/.test(contentType) || contentType.trim() !== contentType)) throw new Error("Invalid content type");
  const sha256 = body.sha256;
  if (sha256 !== undefined && (method !== "PUT" || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))) throw new Error("Invalid checksum");
  return { key, method, expiresIn: Number(expiresIn), contentType: contentType as string | undefined, sha256: sha256 as string | undefined };
}

export async function handleStorageAuthorize(request: Request): Promise<Response> {
  const token = request.headers.get("authorization")?.match(/^Bearer (ocds_[a-f0-9]{64})$/)?.[1];
  if (!token) return reply({ error: "Unauthorized" }, 401);
  const grant = grants().find(item => item.tokenHash === tokenHash(token));
  if (!grant) return reply({ error: "Unauthorized" }, 401);
  const provider = assignedProvider("object_storage");
  if (provider?.id !== grant.providerId || provider.config.endpoint !== grant.endpoint || provider.config.region !== grant.region) return reply({ error: "Storage provider changed; rebind app" }, 409);
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 4096) return reply({ error: "Request too large" }, 413);
    const raw = await request.text();
    if (raw.length > 4096) return reply({ error: "Request too large" }, 413);
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "Invalid request" }, 400);
    const credentials = await getS3Credentials();
    if (!credentials) return reply({ error: "Storage unavailable" }, 503);
    if (assignedProvider("object_storage")?.id !== grant.providerId || credentials.endpoint !== grant.endpoint || credentials.region !== grant.region) return reply({ error: "Storage provider changed; rebind app" }, 409);
    if (body.method === "LIST") {
      if (!grant.methods.includes("LIST") || (body.prefix !== "" && !validObjectKey(body.prefix)) ||
          (body.continuationToken !== undefined && typeof body.continuationToken !== "string")) return reply({ error: "Invalid list request" }, 400);
      const client = new Bun.S3Client({ endpoint: credentials.endpoint, region: credentials.region,
        accessKeyId: credentials.accessKey, secretAccessKey: credentials.secretKey, bucket: grant.bucket });
      const page = await client.list({ prefix: grant.prefix + body.prefix, maxKeys: 1000, continuationToken: body.continuationToken });
      return reply({ ...page, contents: page.contents?.filter(item => item.key?.startsWith(grant.prefix))
        .map(item => ({ ...item, key: item.key?.slice(grant.prefix.length) })) });
    }
    const operation = authorizeObject(grant, body);
    return reply(presignObject({ ...operation, credentials, bucket: grant.bucket }));
  } catch { return reply({ error: "Storage request rejected" }, 400); }
}

export async function handleStorageGrants(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    if (request.method === "GET") return reply(grants().map(({ tokenHash: _, ...grant }) => grant));
    const body = await request.json() as Record<string, unknown>;
    if (request.method === "DELETE") {
      const existing = grants();
      if (typeof body.id !== "string") return reply({ error: "Grant id required" }, 400);
      db.saveSetting(SETTING, JSON.stringify(existing.filter(grant => grant.id !== body.id)));
      return reply({ ok: true });
    }
    // Grants can be prepared before the first deployment. Their lifecycle is
    // explicit: deleting an app does not revoke an independently issued token.
    const app = typeof body.app === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(body.app) ? body.app : null;
    const bucket = validateBucketName(typeof body.bucket === "string" ? body.bucket : "");
    const prefix = body.prefix ?? "";
    const methods = body.methods;
    if (!app || !bucket.valid || typeof prefix !== "string" || (prefix && (!prefix.endsWith("/") || !validObjectKey(prefix))) ||
        !Array.isArray(methods) || !methods.length || methods.some(method => !["GET", "HEAD", "PUT", "DELETE", "LIST"].includes(method))) {
      return reply({ error: "Valid app, bucket, prefix ending in /, and methods are required" }, 400);
    }
    const provider = assignedProvider("object_storage");
    const credentials = await getS3Credentials();
    if (!provider || !credentials) return reply({ error: "Object storage is not configured" }, 409);
    if (!(await listBuckets(credentials)).some(item => item.name === bucket.value)) return reply({ error: "Bucket not found" }, 404);
    const token = `ocds_${randomBytes(32).toString("hex")}`;
    const grant: Grant = { id: crypto.randomUUID(), app, providerId: provider.id, endpoint: credentials.endpoint, region: credentials.region,
      bucket: bucket.value, prefix, methods: methods as Method[], tokenHash: tokenHash(token), createdAt: new Date().toISOString() };
    db.saveSetting(SETTING, JSON.stringify([...grants(), grant]));
    const { tokenHash: _, ...publicGrant } = grant;
    return reply({ ...publicGrant, token }, 201);
  } catch (error) { return handleError(error); }
}
