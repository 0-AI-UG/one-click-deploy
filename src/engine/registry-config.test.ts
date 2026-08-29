import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, test } from "bun:test";
import * as db from "../shared/db.ts";
import { secretStore } from "../shared/secret-store.ts";
import { imageMatchesRegistryScope, resolveRegistryCredentialsForImage } from "./registry-config.ts";

beforeEach(async () => {
  db.saveSetting("oci_artifact_ref", "");
  db.saveSetting("oci_registry_username", "");
  await secretStore.delete("oci_registry_password");
});

describe("fleet OCI registry resolution", () => {
  test("scopes private registry credentials to the configured namespace", async () => {
    db.saveSetting("oci_artifact_ref", "registry.example/ocd/artifacts");
    db.saveSetting("oci_registry_username", "ocd");
    await secretStore.set("oci_registry_password", "secret");
    expect(await resolveRegistryCredentialsForImage("registry.example/ocd/artifacts/app@sha256:" + "a".repeat(64)))
      .toEqual({ username: "ocd", password: "secret" });
    expect(await resolveRegistryCredentialsForImage("registry.example/team/app@sha256:" + "a".repeat(64)))
      .toEqual({});
    expect(await resolveRegistryCredentialsForImage("evil.example/team/app@sha256:" + "a".repeat(64)))
      .toEqual({});
  });

  test("does not confuse sibling namespace prefixes", () => {
    expect(imageMatchesRegistryScope("ghcr.io/acme/app", "ghcr.io/acme")).toBe(true);
    expect(imageMatchesRegistryScope("ghcr.io/acme-tools/app", "ghcr.io/acme")).toBe(false);
  });
});
