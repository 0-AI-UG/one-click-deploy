import { describe, expect, test } from "bun:test";
import { buildServerGcScript, buildServerPruneSteps, parseDockerSize } from "./prune.ts";

describe("buildServerGcScript", () => {
  test("inventories and executes under one transaction with protected ancestors and refs", () => {
    const script = buildServerGcScript({
      activeAppNames: ["api"],
      protectedImageRefs: ["ghcr.io/acme/ocd:sha-abc123"],
      execute: true,
    });

    expect(script).toContain("all_containers=$(docker ps -aq)");
    expect(script).toContain("category=reclaimable-foreign");
    expect(script).toContain("category=reclaimable-ocd");
    expect(script).toContain("ghcr.io/acme/ocd:sha-abc123");
    expect(script).toContain('printf \'%b\\n\' "$protected_images"');
    expect(script).toContain('docker ps -aq --filter ancestor="$id"');
    expect(script).toContain('"($active_pattern):(latest|rollback)"');
    expect(script).toContain('docker image rm "$ref"');
    expect(script).not.toContain("docker image rm -f");
    expect(script).toContain("OCD_SPACE");
  });

  test("dry-run does not contain removal or prune commands", () => {
    const script = buildServerGcScript({ activeAppNames: ["api"], execute: false });
    expect(script).not.toContain('docker image rm "$ref"');
    expect(script).toContain("docker image ls");
  });

  test("fails closed for an unsafe protection name", () => {
    expect(() => buildServerGcScript({ activeAppNames: ["api; docker image prune -af"], execute: true })).toThrow(
      "Unsafe Docker name",
    );
  });

  test("fails closed for an unsafe explicit image reference", () => {
    expect(() => buildServerGcScript({
      activeAppNames: [],
      protectedImageRefs: ["valid:tag'; docker image prune -af"],
      execute: true,
    })).toThrow("Unsafe Docker image reference");
  });
});

describe("parseDockerSize", () => {
  test("parses Docker decimal and binary size formats", () => {
    expect(parseDockerSize("1.35GB (90%)")).toBe(1_350_000_000);
    expect(parseDockerSize("512MiB")).toBe(512 * 1024 * 1024);
    expect(parseDockerSize("0B (0%)")).toBe(0);
    expect(parseDockerSize("unknown")).toBeNull();
  });
});

describe("buildServerPruneSteps", () => {
  test("protects DB-backed sleeping containers and removes only untracked stopped managed containers", () => {
    const script = buildServerPruneSteps({
      activeAppNames: ["api"],
      protectedContainerNames: ["api-r2", "postgres"],
    }).join("; ");

    expect(script).toContain("created|exited|dead");
    expect(script).toContain('case "$name" in api-r2|postgres)');
    expect(script).toContain('*) docker container rm -f "$name"');
    expect(script).toContain('case "$repo" in api)');
    expect(script).toContain('case "$tag" in latest|rollback)');
    expect(script).toContain('docker ps -aq --filter ancestor="$ref"');
  });

  test("retains the current and one previous registry-built panel image", () => {
    const script = buildServerPruneSteps({ panelContainerName: "ocd-panel" }).join("; ");

    expect(script).toContain("docker inspect --format '{{.Config.Image}}' ocd-panel");
    expect(script).toContain('previous_kept=0');
    expect(script).toContain('if [ "$previous_kept" = "0" ]');
    expect(script).toContain('docker image rm "$ref"');
  });

  test("removes orphan containers before attempting stale image removal", () => {
    const steps = buildServerPruneSteps({ activeAppNames: ["api"] });
    expect(steps[0]).toContain("docker container rm");
    expect(steps[1]).toContain("docker image rm");
  });
});
