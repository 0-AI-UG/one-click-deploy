// Set tmp data dir BEFORE importing anything that transitively loads db.ts.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-panel-test-"));

import { describe, test, expect } from "bun:test";
import { buildPanelRebuildScript, ghcrImageForRepo } from "./panel.ts";

describe("ghcrImageForRepo", () => {
  test("derives a lowercase ghcr ref from an https URL with .git", () => {
    expect(ghcrImageForRepo("https://github.com/0-AI-UG/one-click-deploy.git", "latest"))
      .toBe("ghcr.io/0-ai-ug/one-click-deploy:latest");
  });

  test("handles no .git suffix", () => {
    expect(ghcrImageForRepo("https://github.com/x/one-click-deploy", "sha-abc"))
      .toBe("ghcr.io/x/one-click-deploy:sha-abc");
  });

  test("handles ssh (git@) form", () => {
    expect(ghcrImageForRepo("git@github.com:Org/Repo.git", "main"))
      .toBe("ghcr.io/org/repo:main");
  });
});

describe("buildPanelRebuildScript", () => {
  const base = {
    containerName: "ocd-panel",
    image: "ghcr.io/0-ai-ug/one-click-deploy:sha-deadbeef",
    hostPort: 3001,
    containerPort: 3001,
    envFilePath: "/home/deploy/apps/ocd-panel/.env.deploy",
    volumeFlag: "-v /mnt/data:/app/data",
    ghcrEnvPrefix: "DOCKER_CONFIG=/home/deploy/.docker-ocd-xyz ",
    ghcrConfigDir: "/home/deploy/.docker-ocd-xyz",
    pullRetries: 90,
    pullSleepSeconds: 20,
  };

  test("pulls the prebuilt image and no longer runs docker build", () => {
    const script = buildPanelRebuildScript(base);
    expect(script).toContain("docker pull ghcr.io/0-ai-ug/one-click-deploy:sha-deadbeef");
    // The whole point of the change: never build on the panel's own host.
    expect(script).not.toContain("docker build");
    // And no longer git-pulls the source tree.
    expect(script).not.toContain("git pull");
  });

  test("runs the new container on the same loopback port Traefik targets", () => {
    const script = buildPanelRebuildScript(base);
    expect(script).toContain(
      "docker run -d --name ocd-panel --restart unless-stopped -p 127.0.0.1:3001:3001 --env-file /home/deploy/apps/ocd-panel/.env.deploy -v /mnt/data:/app/data ghcr.io/0-ai-ug/one-click-deploy:sha-deadbeef",
    );
    // Old container is removed only after a successful pull (pull-then-swap).
    expect(script).toContain("docker rm -f ocd-panel");
  });

  test("retries the pull the requested number of times and gives up cleanly", () => {
    const script = buildPanelRebuildScript(base);
    expect(script).toContain("for i in $(seq 1 90); do");
    expect(script).toContain("sleep 20");
    expect(script).toContain("leaving current container running");
    // Uses the ephemeral GHCR creds for the pull...
    expect(script).toContain("DOCKER_CONFIG=/home/deploy/.docker-ocd-xyz docker pull");
    // ...and removes the credential dir when done.
    expect(script).toContain("rm -rf /home/deploy/.docker-ocd-xyz");
  });

  test("omits GHCR auth wiring for an anonymous pull", () => {
    const script = buildPanelRebuildScript({ ...base, ghcrEnvPrefix: "", ghcrConfigDir: "" });
    expect(script).toContain("su - deploy -c \"docker pull ghcr.io/0-ai-ug/one-click-deploy:sha-deadbeef\"");
    expect(script).not.toContain("DOCKER_CONFIG=");
    expect(script).not.toContain("rm -rf");
  });
});
