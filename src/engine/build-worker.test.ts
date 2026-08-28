import { describe, expect, test } from "bun:test";
import { BUILD_WORKER_VERSION, buildInstallWorkerScript, normalizeBuildWorkerName } from "./build-worker.ts";

describe("OCD build worker installer", () => {
  test("validates worker names", () => {
    expect(normalizeBuildWorkerName("OCD-Build-1")).toBe("ocd-build-1");
    expect(normalizeBuildWorkerName("bad worker")).toBe("");
  });

  test("converts the GitHub runner before installing build tools", () => {
    const token = "Removal_Token_123456789012345";
    const script = buildInstallWorkerScript(token);
    expect(script).toContain("./config.sh remove --token");
    expect(script.indexOf("./config.sh remove --token")).toBeLessThan(script.indexOf("rm -rf /opt/ocd-actions-runner"));
    expect(script).toContain("apt-get install -y -qq git jq unzip ca-certificates curl");
    expect(script).toContain("docker buildx version");
    expect(script).toContain(BUILD_WORKER_VERSION);
    expect(script).not.toContain("set -x");
  });

  test("new workers need no GitHub registration token", () => {
    const script = buildInstallWorkerScript();
    expect(script).not.toContain("actions/runner/releases");
    expect(script).not.toContain("--labels");
  });
});
