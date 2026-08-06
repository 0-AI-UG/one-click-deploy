import { describe, expect, test } from "bun:test";
import { buildServerPruneSteps } from "./prune.ts";

describe("buildServerPruneSteps", () => {
  test("protects DB-backed sleeping containers and removes only untracked stopped managed containers", () => {
    const script = buildServerPruneSteps({
      activeAppNames: ["api"],
      protectedContainerNames: ["api-r2", "postgres"],
    }).join("; ");

    expect(script).toContain("created|exited|dead");
    expect(script).toContain('case "$name" in api-r2|postgres)');
    expect(script).toContain('*) docker container rm -f "$name"');
    expect(script).toContain('case "$ref" in api:*');
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
