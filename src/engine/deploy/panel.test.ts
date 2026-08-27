// Set tmp data dir BEFORE importing anything that transitively loads db.ts.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-panel-test-"));

import { describe, test, expect } from "bun:test";
import { buildPanelReleaseScript } from "./panel.ts";

describe("buildPanelReleaseScript", () => {
  const base = {
    containerName: "ocd-panel",
    image: "ghcr.io/0-ai-ug/one-click-deploy@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    hostPort: 3001,
    containerPort: 3001,
    privateIpv4: "10.0.0.2",
    envFilePath: "/home/deploy/apps/ocd-panel/.env.deploy",
    volumeFlag: "-v /mnt/data:/app/data",
    registryEnvPrefix: "DOCKER_CONFIG=/home/deploy/.docker-ocd-xyz ",
    registryConfigDir: "/home/deploy/.docker-ocd-xyz",
    pullRetries: 90,
    pullSleepSeconds: 20,
  };

  test("pulls the prebuilt image and no longer runs docker build", () => {
    const script = buildPanelReleaseScript(base);
    expect(script).toContain("docker pull ghcr.io/0-ai-ug/one-click-deploy@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    // The whole point of the change: never build on the panel's own host.
    expect(script).not.toContain("docker build");
    // And no longer git-pulls the source tree.
    expect(script).not.toContain("git pull");
  });

  test("runs the new container on the same loopback port Traefik targets", () => {
    const script = buildPanelReleaseScript(base);
    expect(script).toContain(
      "docker run -d --name ocd-panel --restart unless-stopped --log-opt max-size=20m --log-opt max-file=3 -p 127.0.0.1:3001:3001 -p 10.0.0.2:8896:8896 --env-file /home/deploy/apps/ocd-panel/.env.deploy -v /mnt/data:/app/data ghcr.io/0-ai-ug/one-click-deploy@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    // Old container is removed only after a successful pull (pull-then-swap).
    expect(script).toContain("docker rm -f ocd-panel");
  });

  // A bad migration shipped in a new image took the panel down for ~25 minutes:
  // the swap does `docker rm -f` before starting the replacement, so when the
  // replacement could not boot there was nothing left to serve, and
  // `--restart unless-stopped` crash-looped it forever. The panel also
  // redeploys itself via its own webhook, so once it is down it cannot deploy
  // the fix — recovery required manual SSH. Hence: health-gate the swap and put
  // the previous image back automatically.
  describe("health gate and rollback", () => {
    test("captures the running image before destroying the container", () => {
      const script = buildPanelReleaseScript(base);
      const capture = script.indexOf("PREV_IMAGE=$(docker inspect");
      const destroy = script.indexOf("docker rm -f ocd-panel");
      expect(capture).toBeGreaterThan(-1);
      // Order matters: once the container is gone, its image is unknowable.
      expect(capture).toBeLessThan(destroy);
    });

    test("polls /api/health on the loopback port after the swap", () => {
      const script = buildPanelReleaseScript(base);
      expect(script).toContain("curl -fsS -m 3 http://127.0.0.1:3001/api/health");
    });

    test("restarts the previous image when the new one never becomes healthy", () => {
      const script = buildPanelReleaseScript(base);
      expect(script).toContain('docker run -d --name ocd-panel --restart unless-stopped --log-opt max-size=20m --log-opt max-file=3 -p 127.0.0.1:3001:3001 -p 10.0.0.2:8896:8896 --env-file /home/deploy/apps/ocd-panel/.env.deploy -v /mnt/data:/app/data $PREV_IMAGE');
      expect(script).toContain("rolling back to $PREV_IMAGE");
    });

    test("dumps the failed container's logs so the cause is in the deploy output", () => {
      const script = buildPanelReleaseScript(base);
      expect(script).toContain("docker logs --tail 50 ocd-panel");
    });

    test("does not roll back onto the same image it just failed to start", () => {
      const script = buildPanelReleaseScript(base);
      // A first-ever deploy, or a redeploy of the identical tag, has no distinct
      // previous image — rolling back would just reproduce the failure.
      expect(script).toContain('[ -z "$PREV_IMAGE" ] || [ "$PREV_IMAGE" = "ghcr.io/0-ai-ug/one-click-deploy@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ]');
    });

    test("exits non-zero when it had to roll back, so the deploy is recorded as failed", () => {
      const script = buildPanelReleaseScript(base);
      const lines = script.trim().split("\n");
      expect(lines[lines.length - 1]).toBe("exit 1");
      expect(script).toContain("exit 0");
    });

    test("health retries are configurable", () => {
      const script = buildPanelReleaseScript({ ...base, healthRetries: 5 });
      expect(script).toContain("for i in $(seq 1 5); do");
    });
  });

  test("publishes the HTTP waker port on the private IP so sleeping apps can wake", () => {
    const script = buildPanelReleaseScript(base);
    // Bound to the private IP (not 0.0.0.0): the waker bypasses Traefik's auth /
    // allowlist middleware, so it must never be exposed on the public interface.
    expect(script).toContain("-p 10.0.0.2:8896:8896");
    expect(script).not.toContain("-p 0.0.0.0:8896");
    // HTTP-only scope: the per-app raw TCP/UDP waker ranges are deliberately not
    // published (would be a static 200+200 port block of docker-proxy processes).
    expect(script).not.toContain("21000-21199");
    expect(script).not.toContain("21200-21399");
  });

  test("migrates historical panel data before swapping containers", () => {
    const script = buildPanelReleaseScript({
      ...base,
      volumeHostPath: "/mnt/ocd-ocd-panel-data",
      volumeDevicePath: "/mnt/HC_Volume_105361466",
    });

    const stop = script.indexOf("docker stop ocd-panel");
    const copy = script.indexOf("rsync -aHAX --numeric-ids");
    const bind = script.indexOf("mount --bind /mnt/HC_Volume_105361466 /mnt/ocd-ocd-panel-data");
    const run = script.indexOf("docker run -d --name ocd-panel");
    expect(stop).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(stop);
    expect(bind).toBeGreaterThan(copy);
    expect(run).toBeGreaterThan(bind);
    expect(script).toContain("rsync verification failed");
    expect(script).toContain("# BEGIN ocd-bind panel");
    expect(script).toContain("docker start ocd-panel");
  });

  test("removes the legacy root-disk copy only after the replacement is healthy", () => {
    const script = buildPanelReleaseScript({
      ...base,
      volumeHostPath: "/mnt/ocd-ocd-panel-data",
      volumeDevicePath: "/mnt/HC_Volume_105361466",
    });
    const healthy = script.indexOf('if [ "$healthy" = "1" ]');
    const removePreflip = script.indexOf('rm -rf -- "$MIGRATED_PREFLIP"');
    expect(removePreflip).toBeGreaterThan(healthy);
  });

  test("caps panel container logs on both forward and rollback runs", () => {
    const script = buildPanelReleaseScript(base);
    expect(script.match(/--log-opt max-size=20m/g)?.length).toBe(2);
    expect(script.match(/--log-opt max-file=3/g)?.length).toBe(2);
  });

  test("emits syntactically valid bash with the migration path enabled", async () => {
    const script = buildPanelReleaseScript({
      ...base,
      volumeHostPath: "/mnt/ocd-ocd-panel-data",
      volumeDevicePath: "/mnt/HC_Volume_105361466",
    });
    const proc = Bun.spawn(["bash", "-n"], { stdin: "pipe", stderr: "pipe" });
    proc.stdin.write(script);
    proc.stdin.end();
    const exit = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe("");
    expect(exit).toBe(0);
  });

  test("omits the waker port when the private IP is unknown", () => {
    const script = buildPanelReleaseScript({ ...base, privateIpv4: "" });
    expect(script).not.toContain(":8896:8896");
    // Still runs the panel on its loopback port.
    expect(script).toContain("-p 127.0.0.1:3001:3001");
  });

  test("retries the pull the requested number of times and gives up cleanly", () => {
    const script = buildPanelReleaseScript(base);
    expect(script).toContain("for i in $(seq 1 90); do");
    expect(script).toContain("sleep 20");
    expect(script).toContain("leaving current container running");
    // Uses the ephemeral registry creds for the pull...
    expect(script).toContain("DOCKER_CONFIG=/home/deploy/.docker-ocd-xyz docker pull");
    // ...and removes the credential dir when done.
    expect(script).toContain("rm -rf /home/deploy/.docker-ocd-xyz");
  });

  test("omits registry auth wiring for an anonymous pull", () => {
    const script = buildPanelReleaseScript({ ...base, registryEnvPrefix: "", registryConfigDir: "" });
    expect(script).toContain("su - deploy -c \"docker pull ghcr.io/0-ai-ug/one-click-deploy@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"");
    expect(script).not.toContain("DOCKER_CONFIG=");
    expect(script).not.toContain("rm -rf /home/deploy/.docker-ocd-");
  });
});
