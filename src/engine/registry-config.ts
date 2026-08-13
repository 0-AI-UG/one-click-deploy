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

function registryHost(ref: string): string {
  return ref.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
}

/** Return fleet credentials only when the immutable image is hosted by one of
 * the explicitly configured OCI repositories. This avoids sending a global
 * registry password to an arbitrary manifest host. */
export async function resolveRegistryCredentialsForImage(
  imageRef: string,
): Promise<Pick<RegistryResolution, "username" | "password">> {
  const settings = db.getSettings();
  const allowedHosts = [settings.oci_artifact_ref, settings.oci_cache_ref]
    .filter((ref): ref is string => !!ref)
    .map(registryHost);
  if (!allowedHosts.includes(registryHost(imageRef))) return {};
  return credentials();
}

/** Per-app cache refs remain authoritative; the fleet default fills only an
 * omitted manifest value. */
export async function resolveBuildRegistry(appCacheRef?: string): Promise<RegistryResolution> {
  const ref = appCacheRef || db.getSettings().oci_cache_ref || undefined;
  return { ref, ...(ref ? await credentials() : {}) };
}

/** Release artifacts use their own repository. For backwards compatibility,
 * an app cache ref is still a valid distribution repository when no fleet
 * artifact repository has been configured. */
export async function resolveArtifactRegistry(appCacheRef?: string): Promise<RegistryResolution> {
  const settings = db.getSettings();
  const ref = settings.oci_artifact_ref || appCacheRef || settings.oci_cache_ref || undefined;
  return { ref, ...(ref ? await credentials() : {}) };
}
