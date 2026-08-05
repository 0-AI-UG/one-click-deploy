import { describe, expect, test } from "bun:test";
import { cloudInitScript } from "./cloud-init.ts";

describe("cloud-init host log policy", () => {
  test("bounds persistent and runtime journal growth", () => {
    const script = cloudInitScript();
    expect(script).toContain("SystemMaxUse=500M");
    expect(script).toContain("SystemKeepFree=1G");
    expect(script).toContain("RuntimeMaxUse=100M");
    expect(script).toContain("MaxRetentionSec=7day");
  });
});
