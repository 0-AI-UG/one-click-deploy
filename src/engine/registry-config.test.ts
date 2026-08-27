import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, test } from "bun:test";
import * as db from "../shared/db.ts";
import { secretStore } from "../shared/secret-store.ts";
import { resolveRegistryCredentialsForImage } from "./registry-config.ts";

beforeEach(async () => {
  db.saveSetting("oci_artifact_ref", "");
  db.saveSetting("oci_registry_username", "");
  await secretStore.delete("oci_registry_password");
});

describe("fleet OCI registry resolution", () => {
  test("scopes private registry credentials to configured hosts", async () => {
    db.saveSetting("oci_artifact_ref", "registry.example/ocd/artifacts");
    db.saveSetting("oci_registry_username", "ocd");
    await secretStore.set("oci_registry_password", "secret");
    expect(await resolveRegistryCredentialsForImage("registry.example/team/app@sha256:" + "a".repeat(64)))
      .toEqual({ username: "ocd", password: "secret" });
    expect(await resolveRegistryCredentialsForImage("evil.example/team/app@sha256:" + "a".repeat(64)))
      .toEqual({});
  });
});
