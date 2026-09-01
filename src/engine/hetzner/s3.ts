import { createHash, createHmac } from "node:crypto";
import { getSettings } from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";

export const HETZNER_S3_REGIONS = ["fsn1", "nbg1", "hel1"] as const;
export type HetznerS3Region = (typeof HETZNER_S3_REGIONS)[number];

export const HETZNER_S3_ACCESS_KEY = "hetzner_s3_access_key";
export const HETZNER_S3_SECRET_KEY = "hetzner_s3_secret_key";
export const HETZNER_S3_REGION_SETTING = "hetzner_s3_region";

export type HetznerS3Credentials = {
  accessKey: string;
  secretKey: string;
  region: HetznerS3Region;
};

export type HetznerS3Bucket = {
  name: string;
  createdAt: string;
  region: HetznerS3Region;
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

export function isHetznerS3Region(value: string): value is HetznerS3Region {
  return HETZNER_S3_REGIONS.includes(value as HetznerS3Region);
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

export function endpointForRegion(region: HetznerS3Region): string {
  return `https://${region}.your-objectstorage.com`;
}

export function signS3Request(opts: {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  path: string;
  credentials: HetznerS3Credentials;
  body?: string;
  now?: Date;
  headers?: Record<string, string>;
}): { url: string; headers: Record<string, string> } {
  const now = opts.now ?? new Date();
  const { timestamp, date } = amzDate(now);
  const body = opts.body ?? "";
  const payloadHash = sha256(body);
  const endpoint = new URL(endpointForRegion(opts.credentials.region));
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

export function parseListBuckets(xml: string, region: HetznerS3Region): HetznerS3Bucket[] {
  const buckets: HetznerS3Bucket[] = [];
  for (const match of xml.matchAll(/<Bucket(?:\s[^>]*)?>([\s\S]*?)<\/Bucket>/gi)) {
    const name = xmlTag(match[1], "Name");
    if (!name) continue;
    buckets.push({
      name,
      createdAt: xmlTag(match[1], "CreationDate"),
      region,
      endpoint: endpointForRegion(region),
    });
  }
  return buckets.sort((a, b) => a.name.localeCompare(b.name));
}

export class HetznerS3Error extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "HetznerS3Error";
  }
}

async function s3Request(
  method: "GET" | "PUT" | "DELETE" | "HEAD",
  path: string,
  credentials: HetznerS3Credentials,
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
        ? "Access denied. Check the Hetzner S3 credentials and bucket policy."
        : code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch"
          ? "Invalid Hetzner S3 credentials."
          : providerMessage || `Hetzner S3 request failed (${response.status})`;
    throw new HetznerS3Error(message, response.status, code);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getHetznerS3Credentials(): Promise<HetznerS3Credentials | null> {
  const [accessKey, secretKey] = await Promise.all([
    secretStore.get(HETZNER_S3_ACCESS_KEY),
    secretStore.get(HETZNER_S3_SECRET_KEY),
  ]);
  const rawRegion = getSettings()[HETZNER_S3_REGION_SETTING] ?? "fsn1";
  if (!accessKey || !secretKey || !isHetznerS3Region(rawRegion)) return null;
  return { accessKey, secretKey, region: rawRegion };
}

export async function listBuckets(
  credentials: HetznerS3Credentials,
  fetcher?: typeof fetch,
): Promise<HetznerS3Bucket[]> {
  const response = await s3Request("GET", "/", credentials, { fetcher });
  return parseListBuckets(await response.text(), credentials.region);
}

export async function createBucket(
  name: string,
  credentials: HetznerS3Credentials,
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
  credentials: HetznerS3Credentials,
  fetcher?: typeof fetch,
): Promise<void> {
  const checked = validateBucketName(name);
  if (!checked.valid) throw new Error(checked.error);
  await s3Request("DELETE", `/${encodeURIComponent(checked.value)}`, credentials, { fetcher });
}
