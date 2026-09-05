import * as db from "../shared/db.ts";
import { getInfrastructureToken, secretStore } from "../shared/secret-store.ts";
import { defaultInfrastructureProvider } from "../shared/infrastructure.ts";
import { probeBuildWorker } from "./build-worker.ts";
import { imageMatchesRegistryScope } from "./registry-config.ts";
import { repositoryHost } from "./source-config.ts";

export type ReadinessStatus = "ready" | "warning" | "blocked";
export type DeployReadiness = {
  ready: boolean;
  provider: { status: ReadinessStatus; configured: boolean };
  defaults: { status: ReadinessStatus; server_type: string; location: string };
  worker: {
    status: ReadinessStatus;
    online: number;
    total: number;
    candidate_server: { id: number; name: string } | null;
  };
  registry: {
    status: ReadinessStatus;
    configured: boolean;
    scope: string;
    username: string;
    covers_target: boolean | null;
  };
  source: {
    status: ReadinessStatus;
    configured: boolean;
    host: string;
    covers_repository: boolean | null;
  };
  actions: Array<{ command: string; label: string }>;
};

function unusedReadyServer() {
  const panelServerId = db.getPanel()?.server_id;
  const workerServerIds = new Set(db.getBuildWorkers().map((worker) => worker.server_id));
  return db.getServers().find((server) =>
    server.status === "ready" &&
    server.id !== panelServerId &&
    !workerServerIds.has(server.id) &&
    db.getApps(server.id).length === 0
  );
}

export async function inspectDeployReadiness(input: {
  repository?: string;
  image?: string;
} = {}): Promise<DeployReadiness> {
  const buildDelivery = !!input.repository;
  const settings = db.getSettings();
  const provider = defaultInfrastructureProvider(settings);
  const providerConfigured = !!provider && !!await getInfrastructureToken(provider.id).catch(() => "");
  const workers = buildDelivery ? db.getBuildWorkers() : [];
  let online = 0;
  for (const worker of workers) {
    const server = db.getServer(worker.server_id);
    if (!server || server.status !== "ready") continue;
    const observed = await probeBuildWorker(server).catch(() => ({ online: false }));
    if (observed.online) online++;
  }
  const candidate = unusedReadyServer();
  const scope = settings.oci_artifact_ref || "";
  const registryPassword = await secretStore.get("oci_registry_password");
  const registryConfigured = !!(scope && settings.oci_registry_username && registryPassword);
  const coversTarget = input.image ? imageMatchesRegistryScope(input.image, scope) : null;
  const sourceHost = (settings.github_build_host || "github.com").toLowerCase();
  const sourceToken = await secretStore.get("github_build_token");
  const sourceConfigured = !!sourceToken;
  const coversRepository = input.repository
    ? repositoryHost(input.repository) === sourceHost
    : null;
  const defaultsConfigured = !!(settings.default_server_type && settings.default_location);
  const actions: DeployReadiness["actions"] = [];
  if (buildDelivery && !online) actions.push({
    command: candidate ? `ocd runners install --server=${candidate.id}` : "ocd runners bootstrap",
    label: candidate ? `Install a worker on ${candidate.name}` : "Provision a build worker",
  });
  if (buildDelivery && (!registryConfigured || coversTarget === false)) {
    actions.push({ command: "ocd registry login", label: "Connect the build output registry" });
  }
  if (coversRepository === false && sourceConfigured) actions.push({ command: "ocd source login", label: "Reconnect private source access for this repository host" });

  return {
    ready: !buildDelivery || (online > 0 && registryConfigured && coversTarget !== false),
    provider: { status: providerConfigured ? "ready" : "warning", configured: providerConfigured },
    defaults: {
      status: defaultsConfigured ? "ready" : "warning",
      server_type: settings.default_server_type || "",
      location: settings.default_location || "",
    },
    worker: {
      status: !buildDelivery ? "ready" : online ? "ready" : candidate || (providerConfigured && defaultsConfigured) ? "warning" : "blocked",
      online,
      total: workers.length,
      candidate_server: candidate ? { id: candidate.id, name: candidate.name } : null,
    },
    registry: {
      status: buildDelivery && coversTarget === false
        ? "blocked"
        : registryConfigured ? "ready" : buildDelivery ? "blocked" : "warning",
      configured: registryConfigured,
      scope,
      username: settings.oci_registry_username || "",
      covers_target: coversTarget,
    },
    source: {
      status: !buildDelivery ? "ready" : coversRepository === false ? "warning" : sourceConfigured ? "ready" : "warning",
      configured: sourceConfigured,
      host: sourceHost,
      covers_repository: coversRepository,
    },
    actions,
  };
}
