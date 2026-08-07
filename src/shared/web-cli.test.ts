import { describe, expect, test } from "bun:test";
import { buildWebCliArgv, findWebCliCommand, WEB_CLI_COMMANDS } from "./web-cli.ts";

function command(id: string) {
  const found = findWebCliCommand(id);
  if (!found) throw new Error(`missing test command ${id}`);
  return found;
}

describe("web CLI command catalog", () => {
  test("has unique command ids and represents every top-level CLI command", () => {
    const ids = WEB_CLI_COMMANDS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);

    const represented = new Set(WEB_CLI_COMMANDS.map((item) => item.args[0]));
    for (const name of [
      "login", "apps", "status", "logs", "deploy", "delete", "restart",
      "rollback", "promote", "pause", "unpause", "envs", "service", "stack",
      "ops", "servers", "ssh", "skill", "app", "scale", "resources", "volumes",
    ]) {
      expect(represented.has(name)).toBe(true);
    }
  });

  test("constructs positional values, flags and server-owned safety switches", () => {
    expect(buildWebCliArgv(command("app.rollback"), {
      app: "api",
      deployment: "42",
    })).toEqual(["rollback", "api", "--deployment=42"]);

    expect(buildWebCliArgv(command("app.delete"), { app: "api" })).toEqual([
      "delete", "api", "--yes",
    ]);
  });

  test("expands repeatable values without accepting arbitrary parameters", () => {
    expect(buildWebCliArgv(command("envs.set"), {
      environment: "production",
      vars: "A=1\nB=two",
      rollout: "restart",
    })).toEqual(["envs", "set", "production", "A=1", "B=two", "--rollout=restart"]);

    expect(() => buildWebCliArgv(command("status"), { command: "ssh root" })).toThrow("Unknown parameter");
  });

  test("rejects malformed numbers, key-value entries and disabled commands", () => {
    expect(() => buildWebCliArgv(command("app.logs"), { app: "api", tail: "1.5" })).toThrow("whole number");
    expect(() => buildWebCliArgv(command("envs.create"), { name: "prod", vars: "NOT_A_PAIR" })).toThrow("KEY=VALUE");
    expect(() => buildWebCliArgv(command("app.deploy"), {})).toThrow("local repository manifest");
  });

  test("rejects missing required resource selectors and invalid select values", () => {
    expect(() => buildWebCliArgv(command("app.show"), {})).toThrow("App is required");
    expect(() => buildWebCliArgv(command("envs.set"), {
      environment: "prod",
      vars: "A=1",
      rollout: "invalid",
    })).toThrow("invalid value");
  });

  test("does not allow positional values to smuggle CLI options", () => {
    expect(() => buildWebCliArgv(command("app.show"), { app: "--help" })).toThrow("cannot start with a dash");
    expect(() => buildWebCliArgv(command("envs.unset"), {
      environment: "prod",
      keys: "--replace",
    })).toThrow("cannot start with a dash");
  });

  test("validates contextual numeric resource identities", () => {
    expect(buildWebCliArgv(command("ops.show"), { operation: "42" })).toEqual(["ops", "42"]);
    expect(() => buildWebCliArgv(command("ops.show"), { operation: "latest" })).toThrow("invalid ID");
  });
});
