import { describe, test, expect, beforeEach, mock } from "bun:test";

// Capture every command sshipped to the (mocked) SSH layer so we can assert
// startAppReplica's rm / env-write / hardened-run sequence without a server.
const calls: string[] = [];
mock.module("./ssh.ts", () => ({
  sshExec: mock(async (_ip: string, cmd: string) => {
    calls.push(cmd);
    return { exitCode: 0, stdout: "abc123def456", stderr: "" };
  }),
  getSshKeyPath: () => "/tmp/key",
  describeFailure: (msg: string) => msg,
}));

const { startAppReplica } = await import("./containers.ts");

beforeEach(() => {
  calls.length = 0;
});

describe("startAppReplica", () => {
  test("removes the stale container, then runs a hardened container", async () => {
    const { containerId } = await startAppReplica("1.2.3.4", {
      containerName: "myapp",
      image: "myapp:latest",
      appName: "myapp",
      bindAddr: "10.0.0.1",
      hostPort: 8080,
      containerPort: 3000,
    });
    expect(containerId).toBe("abc123def456");
    expect(calls.some((c) => c.includes("docker rm -f myapp"))).toBe(true);
    const run = calls.find((c) => c.includes("docker run -d"))!;
    expect(run).toBeTruthy();
    // Hardening flags can never be dropped — they flow through buildDockerRunArgs.
    expect(run).toContain("--cap-drop=ALL");
    expect(run).toContain("--security-opt=no-new-privileges");
    expect(run).toContain("--pids-limit");
    expect(run).toContain("-p 10.0.0.1:8080:3000");
    expect(run).toContain("--network ocd-net"); // default network
  });

  test("removeExisting:false skips the rm; network:null omits --network", async () => {
    await startAppReplica("1.2.3.4", {
      containerName: "app2",
      image: "app2:latest",
      appName: "app2",
      bindAddr: "10.0.0.1",
      hostPort: 8081,
      containerPort: 3000,
      network: null,
      removeExisting: false,
    });
    expect(calls.some((c) => c.includes("docker rm -f"))).toBe(false);
    const run = calls.find((c) => c.includes("docker run -d"))!;
    expect(run).not.toContain("--network");
  });

  test("envVars writes a locked-down .env.deploy and mounts it via --env-file", async () => {
    await startAppReplica("1.2.3.4", {
      containerName: "app3",
      image: "app3:latest",
      appName: "app3",
      bindAddr: "10.0.0.1",
      hostPort: 8082,
      containerPort: 3000,
      envVars: { FOO: "bar" },
    });
    const write = calls.find((c) => c.includes(".env.deploy") && c.includes("chmod 600"));
    expect(write).toBeTruthy();
    expect(write).toContain("FOO=bar");
    const run = calls.find((c) => c.includes("docker run -d"))!;
    expect(run).toContain("--env-file /home/deploy/apps/app3/.env.deploy");
  });

  test("rejects a volume host path outside the allowlist", async () => {
    await expect(
      startAppReplica("1.2.3.4", {
        containerName: "app4",
        image: "app4:latest",
        appName: "app4",
        bindAddr: "10.0.0.1",
        hostPort: 8083,
        containerPort: 3000,
        extraVolumes: ["/etc:/etc"],
      }),
    ).rejects.toThrow(/allowlist/);
  });
});
