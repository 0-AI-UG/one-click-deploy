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
  const allowedHosts = [settings.oci_artifact_ref]
    .filter((ref): ref is string => !!ref)
    .map(registryHost);
  if (!allowedHosts.includes(registryHost(imageRef))) return {};
  return credentials();
}
