import { createHash, createHmac } from "node:crypto";
import { secretStore } from "../../shared/secret-store.ts";
import { assignedProvider, providerSecretKey } from "../../shared/provider-connections.ts";

export type S3Credentials = {
  accessKey: string;
  secretKey: string;
  region: string;
  endpoint: string;
};

export type S3Bucket = {
  name: string;
  createdAt: string;
  region: string;
  endpoint: string;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function amzDate(now: Date): { timestamp: string; date: string } {
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { timestamp, date: timestamp.slice(0, 8) };
}

export function isS3Region(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

export function isS3Endpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateBucketName(raw: string): { valid: true; value: string } | { valid: false; error: string } {
  const value = raw.trim().toLowerCase();
  if (value.length < 3 || value.length > 63) {
    return { valid: false, error: "Bucket name must be between 3 and 63 characters" };
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) {
    return { valid: false, error: "Bucket name must start and end with a letter or digit and contain only lowercase letters, digits, dots, or hyphens" };
  }
  if (value.includes("..") || value.includes(".-") || value.includes("-.")) {
    return { valid: false, error: "Bucket name contains an invalid dot sequence" };
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return { valid: false, error: "Bucket name must not look like an IPv4 address" };
  }
  return { valid: true, value };
}

export function signS3Request(opts: {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  path: string;
  credentials: S3Credentials;
  body?: string;
  now?: Date;
  headers?: Record<string, string>;
}): { url: string; headers: Record<string, string> } {
  const now = opts.now ?? new Date();
  const { timestamp, date } = amzDate(now);
  const body = opts.body ?? "";
  const payloadHash = sha256(body);
  const endpoint = new URL(opts.credentials.endpoint);
  const canonicalUri = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const normalizedExtraHeaders = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value.trim()]),
  );
  const headers: Record<string, string> = {
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp,
    ...normalizedExtraHeaders,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    opts.method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${opts.credentials.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${opts.credentials.secretKey}`, date);
  const regionKey = hmac(dateKey, opts.credentials.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host;
  return { url: `${endpoint.origin}${canonicalUri}`, headers };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

export function parseListBuckets(xml: string, credentials: Pick<S3Credentials, "region" | "endpoint">): S3Bucket[] {
  const buckets: S3Bucket[] = [];
  for (const match of xml.matchAll(/<Bucket(?:\s[^>]*)?>([\s\S]*?)<\/Bucket>/gi)) {
    const name = xmlTag(match[1], "Name");
    if (!name) continue;
    buckets.push({
      name,
      createdAt: xmlTag(match[1], "CreationDate"),
      region: credentials.region,
      endpoint: credentials.endpoint,
    });
  }
  return buckets.sort((a, b) => a.name.localeCompare(b.name));
}

export class S3Error extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

async function s3Request(
  method: "GET" | "PUT" | "DELETE" | "HEAD",
  path: string,
  credentials: S3Credentials,
  opts: { body?: string; headers?: Record<string, string>; fetcher?: typeof fetch } = {},
): Promise<Response> {
  const signed = signS3Request({ method, path, credentials, body: opts.body, headers: opts.headers });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await (opts.fetcher ?? fetch)(signed.url, {
      method,
      headers: signed.headers,
      body: method === "PUT" && opts.body ? opts.body : undefined,
      signal: controller.signal,
    });
    if (response.ok) return response;
    const xml = await response.text();
    const code = xmlTag(xml, "Code") || `HTTP_${response.status}`;
    const providerMessage = xmlTag(xml, "Message");
    const message = code === "BucketNotEmpty"
      ? "Bucket is not empty. OCD never recursively deletes objects; remove every object and version first."
      : code === "AccessDenied"
        ? "Access denied. Check the S3 credentials and bucket policy."
        : code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch"
          ? "Invalid S3 credentials."
          : providerMessage || `S3 request failed (${response.status})`;
    throw new S3Error(message, response.status, code);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getS3Credentials(): Promise<S3Credentials | null> {
  const provider = assignedProvider("object_storage");
  if (!provider || provider.kind !== "s3-compatible") return null;
  const [accessKey, secretKey] = await Promise.all([
    secretStore.get(providerSecretKey(provider.id, "access_key")),
    secretStore.get(providerSecretKey(provider.id, "secret_key")),
  ]);
  const region = provider.config.region ?? "";
  const endpoint = provider.config.endpoint ?? "";
  if (!accessKey || !secretKey || !isS3Region(region) || !isS3Endpoint(endpoint)) return null;
  return { accessKey, secretKey, region, endpoint };
}

export async function listBuckets(
  credentials: S3Credentials,
  fetcher?: typeof fetch,
): Promise<S3Bucket[]> {
  const response = await s3Request("GET", "/", credentials, { fetcher });
  return parseListBuckets(await response.text(), credentials);
}

export async function createBucket(
  name: string,
  credentials: S3Credentials,
  fetcher?: typeof fetch,
): Promise<void> {
  const checked = validateBucketName(name);
  if (!checked.valid) throw new Error(checked.error);
  await s3Request("PUT", `/${encodeURIComponent(checked.value)}`, credentials, {
    headers: { "x-amz-acl": "private" },
    fetcher,
  });
}

export async function deleteBucket(
  name: string,
  credentials: S3Credentials,
  fetcher?: typeof fetch,
): Promise<void> {
  const checked = validateBucketName(name);
  if (!checked.valid) throw new Error(checked.error);
  await s3Request("DELETE", `/${encodeURIComponent(checked.value)}`, credentials, { fetcher });
}
