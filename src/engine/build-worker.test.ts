import { describe, expect, test } from "bun:test";
import {
  BUILDX_BUILDER,
  BUILD_PLATFORM,
  branchHeadCommand,
  buildxBuildCommand,
  buildInstallWorkerScript,
  buildWorkerCleanupScript,
  guardedBuildCommand,
  operationImageTag,
  remoteBranchHead,
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
    expect(script).toContain(`docker buildx prune --builder ${BUILDX_BUILDER}`);
    expect(script).toContain("--keep-storage 4GB");
  });

  test("installs the host-lock utilities", () => {
    const script = buildInstallWorkerScript();
    expect(script).toContain("util-linux");
    expect(script).toContain(`docker buildx create --name ${BUILDX_BUILDER} --driver docker-container`);
    expect(script).toContain(`docker buildx inspect ${BUILDX_BUILDER} --bootstrap`);
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
    expect(command).toContain(`--builder '${BUILDX_BUILDER}'`);
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

  test("checks the remote branch from the authenticated checkout", () => {
    const command = branchHeadCommand(
      "/opt/ocd-build-worker/work/op-42/repo",
      "/opt/ocd-build-worker/work/op-42/git-home",
      "main",
    );

    expect(command).toStartWith("cd '/opt/ocd-build-worker/work/op-42/repo' && ");
    expect(command).toContain("HOME='/opt/ocd-build-worker/work/op-42/git-home'");
    expect(command).toContain("git ls-remote --exit-code origin 'refs/heads/main'");
    expect(command).not.toContain("awk");
  });

  test("accepts only a full Git object id from ls-remote", () => {
    const commit = "A".repeat(40);
    expect(remoteBranchHead(`${commit}\trefs/heads/main\n`)).toBe(commit.toLowerCase());
    expect(remoteBranchHead("fatal: authentication failed\n")).toBe("");
    expect(remoteBranchHead("abc\trefs/heads/main\n")).toBe("");
  });
});
