import { describe, expect, test } from "bun:test";
import { buildWebCliArgv, buildWebCliInvocation, findWebCliCommand, WEB_CLI_COMMANDS } from "./web-cli.ts";

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
      "rollback", "promote", "pause", "unpause", "envs", "stack",
      "ops", "servers", "ssh", "skill", "app", "scale", "resources", "volumes",
      "release", "manifest", "gc", "runners", "doctor", "registry", "source",
    ]) {
      expect(represented.has(name)).toBe(true);
    }
  });

  test("constructs positional values and flags", () => {
    expect(buildWebCliArgv(command("app.rollback"), {
      app: "api",
      deployment: "42",
    })).toEqual(["rollback", "api", "--deployment=42"]);

    expect(buildWebCliArgv(command("app.delete"), { app: "api" })).toEqual(["delete", "api"]);
  });

  test("expands repeatable values without accepting arbitrary parameters", () => {
    expect(buildWebCliArgv(command("envs.set"), {
      environment: "production",
      vars: "A=1\nB=two",
      rollout: "restart",
    })).toEqual(["envs", "set", "production", "A=1", "B=two", "--rollout=restart"]);

    expect(() => buildWebCliArgv(command("status"), { command: "ssh root" })).toThrow("Unknown parameter");
    expect(buildWebCliArgv(command("app.show"), {
      app: "api",
      deployment: undefined,
      replica: undefined,
    })).toEqual(["app", "show", "api"]);
  });

  test("rejects malformed numbers and key-value entries", () => {
    expect(() => buildWebCliArgv(command("app.logs"), { app: "api", tail: "1.5" })).toThrow("whole number");
    expect(() => buildWebCliArgv(command("envs.create"), { name: "prod", vars: "NOT_A_PAIR" })).toThrow("KEY=VALUE");
    expect(() => buildWebCliArgv(command("app.deploy"), {})).toThrow("Manifest path is required");
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

  test("keeps secret values out of argv and transports them through stdin", () => {
    const built = buildWebCliInvocation(command("envs.set"), {
      environment: "prod",
      vars: ["PUBLIC=yes"],
      secretVars: ["PASSWORD=correct horse battery staple"],
    });
    expect(built.argv).toEqual(["envs", "set", "prod", "PUBLIC=yes", "--secrets-stdin"]);
    expect(built.argv.join(" ")).not.toContain("correct horse");
    expect(JSON.parse(built.stdin!)).toEqual([{ key: "PASSWORD", value: "correct horse battery staple" }]);
  });

  test("keeps build connection tokens out of process arguments", () => {
    const registry = buildWebCliInvocation(command("registry.login"), {
      scope: "ghcr.io/acme",
      username: "acme",
      token: "registry-secret",
    });
    expect(registry.argv).toEqual(["registry", "login", "ghcr.io/acme", "--username=acme", "--token-stdin"]);
    expect(registry.argv.join(" ")).not.toContain("registry-secret");
    expect(registry.stdin).toBe("registry-secret");
  });

  test("constructs manifest workspace command arguments without accepting source content", () => {
    expect(buildWebCliArgv(command("app.deploy"), {
      manifest: ".ocd-deploy.json",
      commit: "0123456789abcdef",
      dryRun: true,
    })).toEqual(["deploy", ".ocd-deploy.json", "--commit=0123456789abcdef", "--dry-run"]);
  });

});
