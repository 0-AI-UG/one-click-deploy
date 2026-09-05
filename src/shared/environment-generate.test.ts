import { useTempDataDir, randomSuffix } from "./test-helpers.ts";
useTempDataDir();
import { expect, test } from "bun:test";
import * as db from "./db.ts";
import { generateEnvironmentValue } from "./environment-generate.ts";
import { parseEnvVars, resolveEnvVarsForDeploy, serializeEnvVars } from "./env-crypto.ts";

test("credential initialization encrypts a new password and preserves it on repeats", async () => {
  const env = db.insertEnvironment(`generate-${randomSuffix()}`, serializeEnvVars([]));
  expect(await generateEnvironmentValue(env.id, "SESSION_SECRET", "password")).toBe(true);
  const saved = db.getEnvironment(env.id)!.env_vars;
  const entry = parseEnvVars(saved).entries[0]!;
  expect(entry.secret).toBe(true);
  expect(entry.value).toBe("");
  expect((await resolveEnvVarsForDeploy(saved)).SESSION_SECRET).toHaveLength(64);
  expect(await generateEnvironmentValue(env.id, "SESSION_SECRET", "password")).toBe(false);
  expect(db.getEnvironment(env.id)!.env_vars).toBe(saved);
});

test("concurrent initialization creates exactly one value", async () => {
  const env = db.insertEnvironment(`generate-${randomSuffix()}`, serializeEnvVars([]));
  expect((await Promise.all([generateEnvironmentValue(env.id, "TOKEN", "password"), generateEnvironmentValue(env.id, "TOKEN", "password")])).sort()).toEqual([false, true]);
  expect(parseEnvVars(db.getEnvironment(env.id)!.env_vars).entries).toHaveLength(1);
});

test("invalid keys do not modify the environment", async () => {
  const env = db.insertEnvironment(`generate-${randomSuffix()}`, serializeEnvVars([]));
  await expect(generateEnvironmentValue(env.id, "BAD\nKEY", "password")).rejects.toThrow("Invalid environment key");
  expect(parseEnvVars(db.getEnvironment(env.id)!.env_vars).entries).toHaveLength(0);
});
