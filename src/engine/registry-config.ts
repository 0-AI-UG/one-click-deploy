import * as db from "../shared/db.ts";
import { secretStore } from "../shared/secret-store.ts";

export type RegistryResolution = {
  ref?: string;
  username?: string;
  password?: string;
};

async function credentials(): Promise<Pick<RegistryResolution, "username" | "password">> {
  const settings = db.getSettings();
  const password = await secretStore.get("oci_registry_password");
  return {
    username: settings.oci_registry_username || undefined,
    password: password || undefined,
  };
}

/** Canonical repository prefix used as the credential boundary. Credentials
 * configured for `ghcr.io/acme/apps` may be sent to that repository and its
 * descendants, but never to another namespace on the same registry host. */
export function normalizeRegistryScope(ref: string): string {
  return ref.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
}

export function imageMatchesRegistryScope(imageRef: string, configuredRef: string): boolean {
  const image = normalizeRegistryScope(imageRef).split("@", 1)[0];
  const scope = normalizeRegistryScope(configuredRef).replace(/:[^/:]+$/, "");
  return !!scope && (image === scope || image.startsWith(`${scope}/`));
}

/** Return fleet credentials only when the immutable image is hosted by one of
 * the explicitly configured OCI repositories. This avoids sending a global
 * registry password to an arbitrary manifest host. */
export async function resolveRegistryCredentialsForImage(
  imageRef: string,
): Promise<Pick<RegistryResolution, "username" | "password">> {
  const settings = db.getSettings();
  const configuredRef = settings.oci_artifact_ref;
  if (!configuredRef || !imageMatchesRegistryScope(imageRef, configuredRef)) return {};
  return credentials();
}
