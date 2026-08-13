import { describe, expect, mock, test } from "bun:test";

const calls: Array<{ command: string; stdin: string }> = [];
mock.module("./ssh.ts", () => ({
  sshExec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  sshExecWithStdin: async (_ip: string, command: string, stdin: string) => {
    calls.push({ command, stdin });
    return { stdout: "", stderr: "", exitCode: 0 };
  },
}));

const { dockerLoginRegistry } = await import("./registry.ts");

describe("generic OCI registry authentication", () => {
  test("passes hostile password bytes only through stdin", async () => {
    const password = "pa'ss`touch /tmp/nope`$(id);$HOME\\word\nsecond";
    const auth = await dockerLoginRegistry(
      "192.0.2.10", "registry.example/acme/releases", "deploy-user", password,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].stdin).toBe(password);
    expect(calls[0].command).not.toContain(password);
    expect(calls[0].command).not.toContain("touch /tmp/nope");
    expect(calls[0].command).toContain("--password-stdin");
    await auth.cleanup();
  });

  test("rejects a username that could alter the shell command", async () => {
    expect(dockerLoginRegistry(
      "192.0.2.10", "registry.example/acme/releases", "user;id", "secret",
    )).rejects.toThrow("username contains unsupported characters");
  });
});
