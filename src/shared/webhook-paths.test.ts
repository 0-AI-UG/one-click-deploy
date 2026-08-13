import { describe, expect, test } from "bun:test";
import {
  evaluateWebhookPaths,
  legacyWebhookPathToPatterns,
  webhookPathMatches,
} from "./webhook-paths.ts";

describe("webhook path globs", () => {
  test("supports *, ** and ? with case-sensitive slash semantics", () => {
    expect(webhookPathMatches("services/web/src/server.ts", "services/web/**")).toBe(true);
    expect(webhookPathMatches("services/web/README.md", "services/web/**/*.md")).toBe(true);
    expect(webhookPathMatches("services/web/src/README.md", "services/web/**/*.md")).toBe(true);
    expect(webhookPathMatches("admin-ui/a.ts", "admin-ui/?.ts")).toBe(true);
    expect(webhookPathMatches("admin-ui/deep/a.ts", "admin-ui/*.ts")).toBe(false);
    expect(webhookPathMatches("Services/web/a.ts", "services/web/**")).toBe(false);
  });

  test("removes ignored paths before selecting", () => {
    expect(evaluateWebhookPaths(
      ["services/web/README.md"],
      { paths: ["services/web/**"], pathsIgnore: ["services/web/**/*.md"] },
    )).toMatchObject({ selected: false, reason: "no matching changes" });
  });

  test("omitted paths selects every push and legacy path becomes a glob", () => {
    expect(evaluateWebhookPaths([], { paths: null, pathsIgnore: [] }).selected).toBe(true);
    expect(legacyWebhookPathToPatterns("/admin-ui/")).toEqual(["admin-ui/**"]);
  });

  test("manifest paths bypass ordinary paths and ignores", () => {
    expect(evaluateWebhookPaths(
      ["services/web/.ocd-deploy.json"],
      { paths: ["unrelated/**"], pathsIgnore: ["services/**"] },
      ["services/web/.ocd-deploy.json", "ocd-stack.json"],
    )).toMatchObject({ selected: true, matchingPaths: ["services/web/.ocd-deploy.json"] });
  });
});

describe("recommended monorepo filters", () => {
  const filters: Record<string, string[]> = {
    web: [
      ".dockerignore", "package.json", "bun.lock", "packages/core/**", "services/web/**",
      "services/worker/package.json", "services/detector/package.json", "scripts/**",
      "building.json", "docker/derive-db-url.sh",
    ],
    worker: [
      ".dockerignore", "package.json", "bun.lock", "packages/core/**", "services/worker/**",
      "services/web/package.json", "services/detector/package.json", "docker/derive-db-url.sh",
    ],
    detector: [
      ".dockerignore", "package.json", "bun.lock", "packages/core/**", "services/detector/**",
      "services/web/package.json", "services/worker/package.json", "docker/derive-db-url.sh",
    ],
    admin: ["admin-ui/**"],
    Postgres: ["docker/Dockerfile.postgres", "docker/init-postgis.sh"],
  };

  function selected(path: string): string[] {
    return Object.entries(filters)
      .filter(([, paths]) => evaluateWebhookPaths([path], { paths, pathsIgnore: [] }).selected)
      .map(([name]) => name);
  }

  test.each([
    ["ios/Skyline/App.swift", []],
    ["admin-ui/src/index.ts", ["admin"]],
    ["services/web/src/server.ts", ["web"]],
    ["services/worker/src/index.ts", ["worker"]],
    ["services/detector/src/index.ts", ["detector"]],
    ["packages/core/src/db.ts", ["web", "worker", "detector"]],
    ["bun.lock", ["web", "worker", "detector"]],
    ["docker/Dockerfile.postgres", ["Postgres"]],
  ] as Array<[string, string[]]>) ("%s selects only its declared apps", (path, expected) => {
    expect(selected(path)).toEqual(expected);
  });
});
