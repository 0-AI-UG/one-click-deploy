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

  test("uses a non-GitHub host and provider-specific username", async () => {
    db.saveSetting("github_build_host", "gitlab.example");
    db.saveSetting("github_build_username", "git-user");
    await secretStore.set("github_build_token", "secret");
    expect(await resolveSourceCredentialsForRepository("https://gitlab.example/acme/app.git"))
      .toEqual({ username: "git-user", token: "secret" });
    expect(await resolveSourceCredentialsForRepository("https://github.com/acme/app.git"))
      .toEqual({});
  });

  test("keeps legacy token-only GitHub installations working", async () => {
    db.saveSetting("github_build_host", "");
    db.saveSetting("github_build_username", "");
    await secretStore.set("github_build_token", "legacy-secret");
    expect(await resolveSourceCredentialsForRepository("https://github.com/acme/app.git"))
      .toEqual({ username: "x-access-token", token: "legacy-secret" });
  });
});
