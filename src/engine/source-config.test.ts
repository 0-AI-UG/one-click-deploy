import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, test } from "bun:test";
import * as db from "../shared/db.ts";
import { secretStore } from "../shared/secret-store.ts";
import { repositoryHost, resolveSourceCredentialsForRepository } from "./source-config.ts";

beforeEach(async () => {
  db.saveSetting("github_build_host", "github.com");
  db.saveSetting("github_build_username", "x-access-token");
  await secretStore.delete("github_build_token");
});

describe("source credential resolution", () => {
  test("understands HTTPS and SSH repository hosts", () => {
    expect(repositoryHost("https://github.com/acme/app.git")).toBe("github.com");
    expect(repositoryHost("git@gitlab.example:acme/app.git")).toBe("gitlab.example");
  });

  test("never forwards a configured token to another host", async () => {
    await secretStore.set("github_build_token", "secret");
    expect(await resolveSourceCredentialsForRepository("https://github.com/acme/app.git"))
      .toEqual({ username: "x-access-token", token: "secret" });
    expect(await resolveSourceCredentialsForRepository("https://evil.example/acme/app.git"))
      .toEqual({});
  });
});
