import { createHash, createHmac } from "node:crypto";
import type { S3Credentials } from "./s3.ts";

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();

export function validObjectKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && Buffer.byteLength(key) <= 1024 &&
    !/[\x00-\x1f\x7f\\]/.test(key) && !key.startsWith("/") &&
    !key.split("/").some(part => part === "." || part === "..");
}

export function presignObject(input: {
  credentials: S3Credentials; bucket: string; key: string;
  method: "GET" | "PUT" | "HEAD" | "DELETE"; expiresIn: number;
  contentType?: string; sha256?: string; now?: Date;
}): { url: string; headers: Record<string, string> } {
  if (!validObjectKey(input.key)) throw new Error("Invalid object key");
  const endpoint = new URL(input.credentials.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("HTTPS required");
  const timestamp = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const scope = `${date}/${input.credentials.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: endpoint.host };
  if (input.contentType) headers["content-type"] = input.contentType;
  if (input.sha256) headers["x-amz-meta-sha256"] = input.sha256;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const query = Object.entries({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${input.credentials.accessKey}/${scope}`,
    "X-Amz-Date": timestamp, "X-Amz-Expires": String(input.expiresIn), "X-Amz-SignedHeaders": signedHeaders,
  }).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&");
  const path = `/${encode(input.bucket)}/${input.key.split("/").map(encode).join("/")}`;
  const canonical = [input.method, path, query,
    Object.keys(headers).sort().map(key => `${key}:${headers[key]}\n`).join(""), signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretKey}`, date), input.credentials.region), "s3"), "aws4_request");
  const signature = hmac(key, `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).toString("hex");
  delete headers.host;
  return { url: `${endpoint.origin}${path}?${query}&X-Amz-Signature=${signature}`, headers };
}
