import { describe, expect, test } from "bun:test";
import { parseDockerPullTransferBytes } from "./image-transfer.ts";

describe("registry layer transfer accounting", () => {
  test("deduplicates progress frames and sums downloaded compressed layers", () => {
    const output = [
      "aabbccddeeff: Downloading [====> ] 1.0MB/10.0MB",
      "aabbccddeeff: Downloading [========>] 10.0MB/10.0MB",
      "112233445566: Already exists",
      "deadbeefcafe: Downloading [========>] 500kB/500kB",
    ].join("\r");
    expect(parseDockerPullTransferBytes(output)).toBe(10_500_000);
  });

  test("returns unknown when Docker emitted no byte progress", () => {
    expect(parseDockerPullTransferBytes("aabbccddeeff: Pull complete")).toBeUndefined();
  });
});
