import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import {
  buildInstallGitHubRunnerScript,
  probeGitHubRunner,
  runGitHubRunnerInstall,
} from "../github-runner.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

export type InstallGitHubRunnerInput = { runnerId: number; tokenSecretKey: string };
type InstalledOut = { version: string; architecture: string };

const preflight: Step<InstallGitHubRunnerInput, { serverId: number }> = {
  name: "preflight",
  label: "Verify dedicated runner server",
  async run(ctx) {
    const runner = db.getGitHubRunner(ctx.input.runnerId);
    try {
      if (!runner) throw new Error("GitHub runner record not found");
      const server = db.getServer(runner.server_id);
      if (!server) throw new Error("Runner server not found");
      if (db.getPanel()?.server_id === server.id) throw new Error("The panel server cannot run build jobs");
      if (db.getApps(server.id).length > 0 || db.getServicesOnServer(server.id).length > 0) {
        throw new Error("GitHub runners require a dedicated server with no apps or managed services");
      }
      if (server.pool !== "build-runners") {
        throw new Error("Runner server must be isolated in the build-runners pool");
      }
      db.updateGitHubRunner(runner.id, { status: "installing", last_error: "" });
      return { serverId: server.id };
    } catch (error) {
      if (runner) {
        db.updateGitHubRunner(runner.id, {
          status: "error",
          last_error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        });
      }
      await secretStore.delete(ctx.input.tokenSecretKey);
      throw error;
    }
  },
};

const install: Step<InstallGitHubRunnerInput, InstalledOut> = {
  name: "install_runner",
  label: "Install and register GitHub runner",
  async probe(ctx) {
    const runner = db.getGitHubRunner(ctx.input.runnerId);
    const server = runner ? db.getServer(runner.server_id) : null;
    if (!runner || !server) return null;
    const observed = await probeGitHubRunner(server);
    if (!observed.online || !observed.configured) return null;
    return { version: observed.version, architecture: observed.architecture };
  },
  async run(ctx) {
    const runner = db.getGitHubRunner(ctx.input.runnerId);
    const server = runner ? db.getServer(runner.server_id) : null;
    if (!runner || !server) {
      await secretStore.delete(ctx.input.tokenSecretKey);
      throw new Error("Runner or server disappeared during installation");
    }
    const token = await secretStore.get(ctx.input.tokenSecretKey);
    if (!token) {
      const message = "The one-hour GitHub registration token is missing or expired; run install again with a new token";
      db.updateGitHubRunner(runner.id, { status: "error", last_error: message });
      throw new Error(message);
    }
    try {
      const script = buildInstallGitHubRunnerScript({
        scopeUrl: runner.scope_url,
        registrationToken: token,
        runnerName: runner.name,
      });
      const result = await runGitHubRunnerInstall(server, script);
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Runner installation failed");
      const observed = await probeGitHubRunner(server);
      if (!observed.online || !observed.configured) throw new Error(observed.error || "Runner service did not become active");
      ctx.log(`GitHub runner ${runner.name} online (${observed.version}, ${observed.architecture})`);
      return { version: observed.version, architecture: observed.architecture };
    } catch (error) {
      db.updateGitHubRunner(runner.id, {
        status: "error",
        last_error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
      });
      throw error;
    } finally {
      await secretStore.delete(ctx.input.tokenSecretKey);
    }
  },
};

const markReady: Step<InstallGitHubRunnerInput, { ok: true }> = {
  name: "mark_ready",
  label: "Record runner readiness",
  async run(ctx, prior) {
    const runner = db.getGitHubRunner(ctx.input.runnerId);
    if (!runner) throw new Error("GitHub runner record not found");
    const installed = prior.install_runner as InstalledOut;
    db.updateGitHubRunner(runner.id, {
      status: "online",
      last_error: "",
      runner_version: installed.version,
      architecture: installed.architecture,
      last_checked_at: new Date().toISOString(),
    });
    await secretStore.delete(ctx.input.tokenSecretKey);
    return { ok: true };
  },
};

const definition: OpKindDefinition<InstallGitHubRunnerInput> = {
  kind: "install_github_runner",
  label: "Install GitHub Actions runner",
  resourceKeys: (input) => {
    const runner = db.getGitHubRunner(input.runnerId);
    return [`runner:${input.runnerId}`, ...(runner ? [`server:${runner.server_id}`] : [])];
  },
  steps: [preflight, install, markReady],
};

registerOp(definition as OpKindDefinition<any>);
export default definition;
