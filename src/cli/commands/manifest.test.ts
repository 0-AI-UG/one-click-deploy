import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateManifestFile } from "./manifest.ts";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

describe("manifest validate", () => {
  test("recursively validates every stack child", () => {
    dir = mkdtempSync(join(tmpdir(), "ocd-manifest-"));
    const build = {
      repository: "https://github.com/ocd/test",
      branch: "main",
      dockerfile: "Dockerfile",
      context: ".",
      image_repository: "ghcr.io/ocd/test",
      webhook: true,
    };
    writeFileSync(join(dir, "web.json"), JSON.stringify({
      name: "web",
      build,
      container_port: 3000,
      volume: null,
    }));
    writeFileSync(join(dir, "worker.json"), JSON.stringify({
      name: "worker",
      build: { ...build, image_repository: "ghcr.io/ocd/worker" },
      container_port: 3000,
      volume: null,
      typo: true,
    }));
    const stack = join(dir, "ocd-stack.json");
    writeFileSync(stack, JSON.stringify({
      name: "site", apps: { web: { manifest: "web.json" }, worker: { manifest: "worker.json" } },
    }));
    expect(() => validateManifestFile(stack)).toThrow(/Stack app worker.*typo: unknown key/s);
    expect(validateManifestFile(stack, { allowUnknown: true })).toEqual({ kind: "stack", childCount: 2 });
  });
});
