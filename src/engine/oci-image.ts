import { resolveRegistryCredentialsForImage } from "./registry-config.ts";

const DIGEST = /^sha256:[a-f0-9]{64}$/i;
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export type ParsedOciImage = {
  requested: string;
  registry: string;
  apiRegistry: string;
  repository: string;
  reference: string;
  canonicalRepository: string;
};

/** Parse Docker-compatible shorthand without weakening runtime immutability.
 * `postgres:17` becomes docker.io/library/postgres:17; a digest remains a
 * reference and is returned without a registry lookup. */
export function parseOciImage(input: string): ParsedOciImage {
  const requested = input.trim().replace(/^https?:\/\//i, "");
  if (!requested || /[\s?#]/.test(requested)) throw new Error(`Invalid OCI image reference: ${input}`);
  const digestAt = requested.lastIndexOf("@sha256:");
  let name = digestAt >= 0 ? requested.slice(0, digestAt) : requested;
  let reference = digestAt >= 0 ? requested.slice(digestAt + 1) : "";
  if (!reference) {
    const slash = name.lastIndexOf("/");
    const colon = name.lastIndexOf(":");
    if (colon > slash) {
      reference = name.slice(colon + 1);
      name = name.slice(0, colon);
    } else {
      reference = "latest";
    }
  }
  if (!name || !reference || (reference.startsWith("sha256:") && !DIGEST.test(reference))) {
    throw new Error(`Invalid OCI image reference: ${input}`);
  }
  const parts = name.split("/");
  const explicitRegistry = parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost");
  const registry = explicitRegistry ? parts.shift()! : "docker.io";
  let repository = parts.join("/") || name;
  if (registry === "docker.io" && !repository.includes("/")) repository = `library/${repository}`;
  if (!repository.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error(`Invalid OCI image repository: ${input}`);
  }
  return {
    requested,
    registry,
    apiRegistry: registry === "docker.io" ? "registry-1.docker.io" : registry,
    repository,
    reference,
    canonicalRepository: `${registry}/${repository}`,
  };
}

function bearerChallenge(value: string | null): { realm: string; service?: string; scope?: string } | null {
  if (!value?.startsWith("Bearer ")) return null;
  const fields = Object.fromEntries(
    [...value.slice(7).matchAll(/([a-z]+)="([^"]*)"/gi)].map((match) => [match[1].toLowerCase(), match[2]]),
  );
  return fields.realm ? fields as { realm: string; service?: string; scope?: string } : null;
}

async function authToken(
  challenge: { realm: string; service?: string; scope?: string },
  repository: string,
  credentials: { username?: string; password?: string },
): Promise<string> {
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set("service", challenge.service);
  url.searchParams.set("scope", challenge.scope || `repository:${repository}:pull`);
  const headers = new Headers();
  if (credentials.username && credentials.password) {
    headers.set("Authorization", `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`);
  }
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Registry token request failed (${response.status})`);
  const body = await response.json() as { token?: string; access_token?: string };
  const token = body.token || body.access_token;
  if (!token) throw new Error("Registry token response did not contain a token");
  return token;
}

async function manifestRequest(parsed: ParsedOciImage, authorization?: string): Promise<Response> {
  const headers = new Headers({ Accept: ACCEPT });
  if (authorization) headers.set("Authorization", authorization);
  return fetch(`https://${parsed.apiRegistry}/v2/${parsed.repository}/manifests/${parsed.reference}`, {
    method: "GET",
    headers,
  });
}

/** Resolve a user-facing tag or digest to the exact immutable artifact OCD
 * stores and runs. No desired state changes before this function succeeds. */
export async function resolveOciImage(input: string): Promise<string> {
  const parsed = parseOciImage(input);
  if (DIGEST.test(parsed.reference)) return `${parsed.canonicalRepository}@${parsed.reference.toLowerCase()}`;

  const credentials = await resolveRegistryCredentialsForImage(parsed.requested);
  const basic = credentials.username && credentials.password
    ? `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`
    : undefined;
  let response = await manifestRequest(parsed, basic);
  if (response.status === 401) {
    const challenge = bearerChallenge(response.headers.get("www-authenticate"));
    if (!challenge) throw new Error(`Registry rejected ${input} without a supported authentication challenge`);
    const token = await authToken(challenge, parsed.repository, credentials);
    response = await manifestRequest(parsed, `Bearer ${token}`);
  }
  if (!response.ok) throw new Error(`Unable to resolve OCI image ${input} (${response.status})`);
  let digest = response.headers.get("docker-content-digest")?.toLowerCase() || "";
  const bytes = await response.arrayBuffer();
  if (!DIGEST.test(digest)) {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    digest = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `${parsed.canonicalRepository}@${digest}`;
}
