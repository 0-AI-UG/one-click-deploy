import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import {
  buildRemoveGitHubRunnerScript,
  probeGitHubRunner,
  runGitHubRunnerInstall,
} from "../github-runner.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

export type RemoveGitHubRunnerInput = { runnerId: number; tokenSecretKey: string };
type RunnerSnapshot = { serverId: number; previousPool: string; name: string };

const preflight: Step<RemoveGitHubRunnerInput, RunnerSnapshot> = {
  name: "preflight",
  label: "Load runner",
  async run(ctx) {
    const runner = db.getGitHubRunner(ctx.input.runnerId);
    try {
      if (!runner) throw new Error("GitHub runner not found");
      if (!db.getServer(runner.server_id)) throw new Error("Runner server not found");
      db.updateGitHubRunner(runner.id, { status: "removing", last_error: "" });
      return { serverId: runner.server_id, previousPool: runner.previous_pool, name: runner.name };
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

const remove: Step<RemoveGitHubRunnerInput, RunnerSnapshot> = {
  name: "remove_runner",
  label: "Deregister and remove GitHub runner",
  async probe(ctx, prior) {
    const snapshot = prior.preflight as RunnerSnapshot;
    const server = db.getServer(snapshot.serverId);
    if (!server) return snapshot;
    const observed = await probeGitHubRunner(server);
    if (observed.error) return null;
    return observed.configured ? null : snapshot;
  },
  async run(ctx, prior) {
    const snapshot = prior.preflight as RunnerSnapshot;
    const server = db.getServer(snapshot.serverId);
    if (!server) return snapshot;
    const token = await secretStore.get(ctx.input.tokenSecretKey);
    if (!token) {
      const message = "The one-hour GitHub removal token is missing or expired; run remove again with a new token";
      db.updateGitHubRunner(ctx.input.runnerId, { status: "error", last_error: message });
      throw new Error(message);
    }
    try {
      const result = await runGitHubRunnerInstall(server, buildRemoveGitHubRunnerScript(token));
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Runner removal failed");
      ctx.log(`GitHub runner ${snapshot.name} deregistered and removed`);
      return snapshot;
    } catch (error) {
      db.updateGitHubRunner(ctx.input.runnerId, {
        status: "error",
        last_error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
      });
      throw error;
    } finally {
      await secretStore.delete(ctx.input.tokenSecretKey);
    }
  },
};

const deleteRow: Step<RemoveGitHubRunnerInput, { ok: true }> = {
  name: "delete_runner_row",
  label: "Release dedicated server",
  async probe(ctx) {
    return db.getGitHubRunner(ctx.input.runnerId) ? null : { ok: true };
  },
  async run(ctx, prior) {
    const snapshot = prior.remove_runner as RunnerSnapshot;
    const server = db.getServer(snapshot.serverId);
    if (server) {
      db.updateServerPool(server.id, snapshot.previousPool || "general");
      db.clearServerGcRequest(server.id);
    }
    await secretStore.delete(ctx.input.tokenSecretKey);
    db.deleteGitHubRunner(ctx.input.runnerId);
    return { ok: true };
  },
};

const definition: OpKindDefinition<RemoveGitHubRunnerInput> = {
  kind: "remove_github_runner",
  label: "Remove GitHub Actions runner",
  resourceKeys: (input) => {
    const runner = db.getGitHubRunner(input.runnerId);
    return [`runner:${input.runnerId}`, ...(runner ? [`server:${runner.server_id}`] : [])];
  },
  steps: [preflight, remove, deleteRow],
};

registerOp(definition as OpKindDefinition<any>);
export default definition;
