import { describe, test, expect } from "bun:test";
import { buildDockerRunArgs, DEFAULT_MEM_MB, DEFAULT_CPUS, DEFAULT_PIDS } from "./containers.ts";

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

  test("userns adds seccomp=unconfined (opt-in), default keeps it hardened", () => {
    const off = buildDockerRunArgs({ name: "x", image: "x:latest", appName: "x" });
    expect(off).not.toContain("seccomp=unconfined");

    const on = buildDockerRunArgs({ name: "x", image: "x:latest", appName: "x", userns: true });
    expect(on).toContain("--security-opt=seccomp=unconfined");
    // SETUID/SETGID added back so bubblewrap can write uid/gid maps
    expect(on).toContain("--cap-add=SETUID");
    expect(on).toContain("--cap-add=SETGID");
    // hardening is still applied alongside it
    expect(on).toContain("--cap-drop=ALL");
    expect(on).toContain("--security-opt=no-new-privileges");
  });

  test("network: null omits --network", () => {
    const cmd = buildDockerRunArgs({ name: "x", image: "x:latest", appName: "x", network: null });
    expect(cmd).not.toContain("--network");
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
