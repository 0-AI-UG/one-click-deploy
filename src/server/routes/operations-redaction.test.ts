import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();
import { expect, test } from "bun:test";
import { redact } from "./operations.ts";

test("operation responses hide manifest and resolved runtime values recursively", () => {
  const output = redact({ spec: { env: { KEY: "private" }, outputs: { URL: { template: "private" } }, app_name: "api" }, step: { flatEnvVars: { KEY: "private" } } });
  expect(JSON.stringify(output)).not.toContain("private");
  expect(output).toEqual({ spec: { env: "[redacted]", outputs: "[redacted]", app_name: "api" }, step: { flatEnvVars: "[redacted]" } });
});
