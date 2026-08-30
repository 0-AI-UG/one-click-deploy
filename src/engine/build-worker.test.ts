import { describe, expect, test } from "bun:test";
import {
  buildInstallWorkerScript,
  buildWorkerCleanupScript,
  guardedBuildCommand,
  operationImageTag,
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
});
