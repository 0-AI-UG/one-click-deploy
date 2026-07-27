import { describe, test, expect } from "bun:test";
import { buildDockerRunArgs, DEFAULT_MEM_MB, DEFAULT_CPUS, DEFAULT_PIDS } from "./containers.ts";
import { withExclusiveImageGc, withImageGcLease } from "./container-common.ts";

describe("buildDockerRunArgs", () => {
  test("always emits hardening flags", () => {
    const cmd = buildDockerRunArgs({
      name: "myapp",
      image: "myapp:latest",
      appName: "myapp",
      publish: { bindAddr: "127.0.0.1", hostPort: 8080, containerPort: 3000 },
    });
    expect(cmd).toContain("--cap-drop=ALL");
    expect(cmd).toContain("--security-opt=no-new-privileges");
    expect(cmd).toContain(`--memory ${DEFAULT_MEM_MB}m`);
    expect(cmd).toContain(`--memory-swap ${DEFAULT_MEM_MB}m`);
    expect(cmd).toContain(`--cpus ${DEFAULT_CPUS}`);
    expect(cmd).toContain(`--pids-limit ${DEFAULT_PIDS}`);
    expect(cmd).toContain("--network ocd-net");
    expect(cmd).toContain("--restart unless-stopped");
    expect(cmd).toContain("-p 127.0.0.1:8080:3000");
    expect(cmd.endsWith(" myapp:latest")).toBe(true);
  });

  test("honors per-call overrides", () => {
    const cmd = buildDockerRunArgs({
      name: "pg",
      image: "postgres:17-alpine",
      appName: "pg",
      memoryMb: 2048,
      cpus: 2,
      pidsLimit: 4096,
      extraCaps: ["CHOWN", "SETUID"],
    });
    expect(cmd).toContain("--memory 2048m");
    expect(cmd).toContain("--cpus 2");
    expect(cmd).toContain("--pids-limit 4096");
    expect(cmd).toContain("--cap-add=CHOWN");
    expect(cmd).toContain("--cap-add=SETUID");
  });

  test("network: null omits --network", () => {
    const cmd = buildDockerRunArgs({ name: "x", image: "x:latest", appName: "x", network: null });
    expect(cmd).not.toContain("--network");
  });

  test("injects managed-service aliases even when app replicas use the default bridge", () => {
    const cmd = buildDockerRunArgs({
      name: "api",
      image: "api:latest",
      appName: "api",
      network: null,
      extraHosts: [
        { hostname: "postgres.svc.ocd.internal", address: "10.0.0.8" },
        { hostname: "redis.svc.ocd.internal", address: "10.0.0.9" },
      ],
    });
    expect(cmd).not.toContain("--network");
    expect(cmd).toContain("--add-host=postgres.svc.ocd.internal:10.0.0.8");
    expect(cmd).toContain("--add-host=redis.svc.ocd.internal:10.0.0.9");
  });

  test("rejects unsafe service alias values", () => {
    expect(() => buildDockerRunArgs({
      name: "api",
      image: "api:latest",
      appName: "api",
      extraHosts: [{ hostname: "db;touch /tmp/pwn", address: "10.0.0.8" }],
    })).toThrow(/Invalid extra host name/);
  });

  test("accepts allowlisted volumes", () => {
    const cmd = buildDockerRunArgs({
      name: "myapp",
      image: "myapp:latest",
      appName: "myapp",
      volumeMount: "/mnt/ocd-myapp-data:/data",
      extraVolumes: ["/home/deploy/apps/myapp/volumes/cache:/cache"],
    });
    expect(cmd).toContain("-v /mnt/ocd-myapp-data:/data");
    expect(cmd).toContain("-v /home/deploy/apps/myapp/volumes/cache:/cache");
  });

  test("rejects volume outside allowlist (defense in depth)", () => {
    expect(() =>
      buildDockerRunArgs({
        name: "myapp",
        image: "myapp:latest",
        appName: "myapp",
        extraVolumes: ["/etc:/etc"],
      }),
    ).toThrow(/allowlist/);
  });

  test("includes env file when provided", () => {
    const cmd = buildDockerRunArgs({
      name: "myapp",
      image: "myapp:latest",
      appName: "myapp",
      envFilePath: "/home/deploy/apps/myapp/.env.deploy",
    });
    expect(cmd).toContain("--env-file /home/deploy/apps/myapp/.env.deploy");
  });

  test("appends trailing cmd if provided", () => {
    const cmd = buildDockerRunArgs({
      name: "x",
      image: "x:latest",
      appName: "x",
      cmd: "'arg1' 'arg2'",
    });
    expect(cmd.endsWith("x:latest 'arg1' 'arg2'")).toBe(true);
  });
});

describe("image GC coordination", () => {
  test("builds and image consumers share a host lock while prune is exclusive", () => {
    const build = withImageGcLease("docker build -t app:latest .");
    const run = withImageGcLease("docker run app:latest");
    const prune = withExclusiveImageGc("docker image prune -af");

    expect(build).toContain("flock -s");
    expect(run).toContain("flock -s");
    expect(prune).toContain("flock -x");
    expect(build).toContain("/tmp/ocd-image-gc.lock");
    expect(prune).toContain("/tmp/ocd-image-gc.lock");
  });
});
