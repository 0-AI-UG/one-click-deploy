import { describe, test, expect, beforeEach, mock } from "bun:test";

// Capture every command sshipped to the (mocked) SSH layer so we can assert
// startAppReplica's rm / env-write / hardened-run sequence without a server.
// `stubs` lets a test shape the reply for a command matching a substring (used
// to drive the image-inspect / `id` probe of the volume-ownership fix).
const calls: string[] = [];
let stubs: Array<{ match: string; stdout: string; exitCode?: number }> = [];
mock.module("./ssh.ts", () => ({
  sshExec: mock(async (_ip: string, cmd: string) => {
    calls.push(cmd);
    const stub = stubs.find((s) => cmd.includes(s.match));
    if (stub) return { exitCode: stub.exitCode ?? 0, stdout: stub.stdout, stderr: "" };
    return { exitCode: 0, stdout: "abc123def456", stderr: "" };
  }),
  getSshKeyPath: () => "/tmp/key",
  buildSshArgs: () => ({ args: [], tmpKnownHostsPath: null }),
  describeFailure: (msg: string) => msg,
}));

const { startAppReplica } = await import("./docker-run.ts");

beforeEach(() => {
  calls.length = 0;
  stubs = [];
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

  test("chowns a fresh volume root to the image's runtime uid before running (non-root image)", async () => {
    // Image runs as a named user; `id` reports the numeric ids. postgres-alpine = 70:70.
    stubs = [
      { match: "{{.Config.User}}", stdout: "postgres" },
      // The shared deploy-user wrapper safely shell-quotes the empty entrypoint,
      // so match the stable image/id portion rather than its outer quoting.
      { match: "postgres-pg:latest id", stdout: "uid=70(postgres) gid=70(postgres) groups=70(postgres)" },
    ];
    await startAppReplica("1.2.3.4", {
      containerName: "pg",
      image: "postgres-pg:latest",
      appName: "pg",
      bindAddr: "10.0.0.1",
      hostPort: 8084,
      containerPort: 5432,
      volumeMount: "/mnt/ocd-pg-data:/var/lib/postgresql/data",
    });
    const chown = calls.find((c) => c.includes("chown 70:70 /mnt/ocd-pg-data"));
    expect(chown).toContain("chown 70:70 /mnt/ocd-pg-data");
    // The chown must precede the run that mounts the volume.
    const chownIdx = calls.findIndex((c) => c.includes("chown 70:70 /mnt/ocd-pg-data"));
    const runIdx = calls.findIndex((c) => c.includes("docker run -d"));
    expect(chownIdx).toBeGreaterThanOrEqual(0);
    expect(chownIdx).toBeLessThan(runIdx);
  });

  test("skips the chown for a root image", async () => {
    stubs = [{ match: "{{.Config.User}}", stdout: "" }];
    await startAppReplica("1.2.3.4", {
      containerName: "rootapp",
      image: "rootapp:latest",
      appName: "rootapp",
      bindAddr: "10.0.0.1",
      hostPort: 8085,
      containerPort: 3000,
      volumeMount: "/mnt/ocd-rootapp-data:/data",
    });
    expect(calls.some((c) => c.includes("chown "))).toBe(false);
  });

  test("no volume → no inspect, no chown", async () => {
    await startAppReplica("1.2.3.4", {
      containerName: "novol",
      image: "novol:latest",
      appName: "novol",
      bindAddr: "10.0.0.1",
      hostPort: 8086,
      containerPort: 3000,
    });
    expect(calls.some((c) => c.includes("{{.Config.User}}"))).toBe(false);
    expect(calls.some((c) => c.includes("chown "))).toBe(false);
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
