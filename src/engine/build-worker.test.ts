import { describe, expect, test } from "bun:test";
import {
  BUILD_PLATFORM,
  buildxBuildCommand,
  buildInstallWorkerScript,
  buildWorkerCleanupScript,
  guardedBuildCommand,
  operationImageTag,
  registryBuildCacheRef,
} from "./build-worker.ts";

describe("build worker command safety", () => {
  test("uses an operation-specific transport tag", () => {
    expect(operationImageTag("registry.example.com/acme/api", 42, "a".repeat(40)))
      .toBe(`registry.example.com/acme/api:ocd-op-42-${"a".repeat(12)}`);
  });

  test("guards the remote build with a non-blocking host lock and process group", () => {
    const command = guardedBuildCommand("docker buildx build --push .");
    expect(command).toContain("flock -n -E 75");
    expect(command).toContain("setsid sh -c");
  });

  test("kills the recorded process group before cleanup and serializes pruning", () => {
    const script = buildWorkerCleanupScript("/opt/ocd-build-worker/work/op-42");
    expect(script).toContain('kill -TERM -- "-$pid"');
    expect(script).toContain('kill -KILL -- "-$pid"');
    expect(script).toContain("flock -w 30 /opt/ocd-build-worker/build.lock");
  });

  test("installs the host-lock utilities", () => {
    expect(buildInstallWorkerScript()).toContain("util-linux");
  });

  test("uses a per-image registry cache without weakening digest identity", () => {
    const image = "registry.example.com/acme/api";
    const tag = operationImageTag(image, 42, "a".repeat(40));
    const command = buildxBuildCommand({
      commit: "a".repeat(40),
      dockerfile: "Dockerfile",
      context: ".",
      tag,
      metadataFile: "/tmp/build.json",
    });

    expect(registryBuildCacheRef(image)).toBe(`${image}:ocd-buildcache`);
    expect(command).toContain(`--platform '${BUILD_PLATFORM}'`);
    expect(command).toContain(`--cache-from 'type=registry,ref=${image}:ocd-buildcache'`);
    expect(command).toContain(`--cache-to 'type=registry,ref=${image}:ocd-buildcache,mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true'`);
    expect(command).toContain(`-t '${tag}'`);
  });

  test("can disable cache and rejects unsupported runtime platforms", () => {
    const input = {
      commit: "a".repeat(40),
      dockerfile: "Dockerfile",
      context: ".",
      tag: operationImageTag("registry.example.com/acme/api", 7, "a".repeat(40)),
      metadataFile: "/tmp/build.json",
    };
    expect(buildxBuildCommand({ ...input, cache: false })).not.toContain("--cache-");
    expect(() => buildxBuildCommand({ ...input, platform: "linux/arm64" })).toThrow("Unsupported build platform");
  });
});
