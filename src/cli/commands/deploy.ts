import { get, post } from "../api.ts";
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "../format.ts";

interface DeployJobPoll {
  status: "running" | "done" | "error";
  events: Array<{ seq: number; step: string; detail: string }>;
  last_seq: number;
  result: { ok: boolean; error?: string } | null;
}

interface IntrospectResult {
  ok: boolean;
  error?: string;
  suggested_app_name?: string;
  default_branch?: string;
  detected_port?: number | null;
  dockerfiles?: string[];
  compose_files?: string[];
  suggested_web_service?: string | null;
  compose_services?: Array<{ name: string; port: number | null; has_ports: boolean }>;
  env_vars?: Array<{ key: string; value: string }>;
  manifests?: Array<{
    path: string;
    dir: string;
    manifest: {
      name: string;
      description?: string;
      build?: {
        dockerfile?: string;
        context?: string;
        container_port?: number;
        compose_file?: string;
        compose_web_service?: string;
      };
      env?: Array<{ key: string; description?: string; default?: string; required?: boolean; secret?: boolean }>;
      volume?: { size?: number; path?: string };
      webhook?: { enabled?: boolean; branch?: string; path?: string; wait_for_ci?: boolean };
      suggested_app_name?: string;
      replicas?: number;
      public?: boolean;
      extra_volumes?: Array<{ host_path: string; container_path: string }>;
    };
  }>;
  notes?: string[];
}

function parseFlags(args: string[]): { repo: string; flags: Record<string, string>; envPairs: Array<[string, string]>; extraVolumes: Array<[string, string]> } {
  let repo = "";
  const flags: Record<string, string> = {};
  const envPairs: Array<[string, string]> = [];
  const extraVolumes: Array<[string, string]> = [];

  for (const arg of args) {
    if (arg.startsWith("--env=")) {
      const kv = arg.slice(6);
      const eq = kv.indexOf("=");
      if (eq !== -1) envPairs.push([kv.slice(0, eq), kv.slice(eq + 1)]);
    } else if (arg.startsWith("--volume=")) {
      // --volume=host:container
      const parts = arg.slice(9).split(":");
      if (parts.length === 2) extraVolumes.push([parts[0], parts[1]]);
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = "true";
      }
    } else if (!repo) {
      repo = arg;
    }
  }

  return { repo, flags, envPairs, extraVolumes };
}

export async function deploy(args: string[]): Promise<void> {
  const { repo, flags, envPairs, extraVolumes } = parseFlags(args);

  if (!repo) {
    console.error(`${BOLD}Usage:${RESET} ocd deploy <git-repo> [options]

${BOLD}Options:${RESET}
  --name=<name>              App name (default: derived from repo)
  --domain=<domain>          Custom domain
  --port=<port>              Container port (default: auto-detect)
  --env=KEY=VALUE            Environment variable (repeatable)
  --environment=<id>         Link to an existing environment
  --dockerfile=<path>        Dockerfile path
  --docker-context=<path>    Docker build context (default: ".")
  --compose=<path>           Docker Compose file path
  --compose-service=<name>   Compose web service name
  --branch=<branch>          Webhook branch to watch
  --webhook                  Enable webhook auto-deploy
  --webhook-path=<path>      Webhook path filter
  --webhook-wait-ci          Wait for CI checks before deploying
  --replicas=<n>             Number of replicas
  --auth-password=<pw>       Password-protect the app
  --volume-size=<gb>         Attach a volume (size in GB)
  --volume-path=<path>       Volume mount path (default: /data)
  --volume=<host>:<container> Extra volume mount (repeatable)
  --private                  Make app private (not publicly accessible)
  --manifest=<n>             Use the Nth manifest from repo (1-based)
  --no-introspect            Skip repo introspection`);
    process.exit(1);
  }

  // Introspect the repo unless --no-introspect is set
  let introspect: IntrospectResult | null = null;
  if (flags["no-introspect"] !== "true") {
    process.stdout.write(`${DIM}Inspecting repo...${RESET}`);
    try {
      introspect = await get<IntrospectResult>(`/api/repos/introspect?url=${encodeURIComponent(repo)}`);
      process.stdout.write("\r" + " ".repeat(40) + "\r");
      if (!introspect.ok) {
        console.log(`${YELLOW}Introspection warning: ${introspect.error}${RESET}`);
        introspect = null;
      }
    } catch {
      process.stdout.write("\r" + " ".repeat(40) + "\r");
    }
  }

  // If a manifest is selected, apply its defaults
  let manifest: IntrospectResult["manifests"] extends (infer T)[] | undefined ? T extends undefined ? never : T : never;
  if (flags.manifest && introspect?.manifests?.length) {
    const idx = parseInt(flags.manifest, 10) - 1;
    if (idx >= 0 && idx < introspect.manifests.length) {
      manifest = introspect.manifests[idx];
      console.log(`Using manifest: ${BOLD}${manifest.manifest.name}${RESET}${manifest.manifest.description ? ` — ${manifest.manifest.description}` : ""}`);
    } else {
      console.error(`Invalid manifest index. Available manifests:`);
      introspect.manifests.forEach((m, i) => {
        console.error(`  ${i + 1}. ${m.manifest.name}${m.manifest.description ? ` — ${m.manifest.description}` : ""}`);
      });
      process.exit(1);
    }
  } else if (!flags.manifest && introspect?.manifests?.length) {
    // Auto-select if there's exactly one manifest
    if (introspect.manifests.length === 1) {
      manifest = introspect.manifests[0];
      console.log(`Using manifest: ${BOLD}${manifest.manifest.name}${RESET}${manifest.manifest.description ? ` — ${manifest.manifest.description}` : ""}`);
    } else {
      console.log(`${YELLOW}Multiple manifests found. Use --manifest=N to select:${RESET}`);
      introspect.manifests.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.manifest.name}${m.manifest.description ? ` — ${m.manifest.description}` : ""}`);
      });
    }
  }

  const m = manifest?.manifest;

  // Resolve app name: flag > manifest > introspect > derive from repo
  const name = flags.name
    || m?.suggested_app_name
    || introspect?.suggested_app_name
    || repo.replace(/.*\//, "").replace(/\.git$/, "");

  // Resolve port: flag > manifest > introspect > 3000
  const port = flags.port
    ? parseInt(flags.port, 10)
    : m?.build?.container_port
      ?? introspect?.detected_port
      ?? 3000;

  // Build deploy request body
  const body: Record<string, unknown> = {
    app_name: name,
    git_repo: repo,
    container_port: port,
  };

  // Domain
  if (flags.domain) body.domain = flags.domain;

  // Dockerfile / build context
  body.dockerfile_path = flags.dockerfile || m?.build?.dockerfile || undefined;
  body.docker_context = flags["docker-context"] || m?.build?.context || undefined;

  // Compose
  body.compose_file = flags.compose || m?.build?.compose_file || undefined;
  body.compose_web_service = flags["compose-service"]
    || m?.build?.compose_web_service
    || introspect?.suggested_web_service
    || undefined;

  // Webhook settings
  const webhookEnabled = flags.webhook === "true"
    || flags.branch !== undefined
    || m?.webhook?.enabled === true;
  if (webhookEnabled) {
    body.webhook_enabled = true;
    body.webhook_branch = flags.branch || m?.webhook?.branch || introspect?.default_branch || "main";
    if (flags["webhook-path"] || m?.webhook?.path) {
      body.webhook_path = flags["webhook-path"] || m?.webhook?.path;
    }
    if (flags["webhook-wait-ci"] === "true" || m?.webhook?.wait_for_ci) {
      body.webhook_wait_for_ci = true;
    }
  }

  // Replicas
  if (flags.replicas) body.replicas = parseInt(flags.replicas, 10);
  else if (m?.replicas) body.replicas = m.replicas;

  // Auth password
  if (flags["auth-password"]) body.auth_password = flags["auth-password"];

  // Volume
  const volSize = flags["volume-size"] ? parseInt(flags["volume-size"], 10) : m?.volume?.size;
  if (volSize) {
    body.volume_size = volSize;
    body.volume_path = flags["volume-path"] || m?.volume?.path || "/data";
  }

  // Extra volumes
  const allExtraVolumes = [
    ...extraVolumes.map(([h, c]) => ({ host_path: h, container_path: c })),
    ...(m?.extra_volumes || []),
  ];
  if (allExtraVolumes.length > 0) body.extra_volumes = allExtraVolumes;

  // Public flag
  if (flags.private === "true") body.public = false;
  else if (m?.public !== undefined) body.public = m.public;

  // Environment variables: flag > environment link > manifest env + introspect env
  if (flags.environment) {
    body.environment_id = parseInt(flags.environment, 10);
  } else {
    const envVars: Record<string, string> = {};

    // Start with manifest defaults
    if (m?.env) {
      for (const e of m.env) {
        if (e.default !== undefined) envVars[e.key] = e.default;
      }
    }

    // Layer introspected .env.example values
    if (introspect?.env_vars) {
      for (const e of introspect.env_vars) {
        if (!(e.key in envVars)) envVars[e.key] = e.value;
      }
    }

    // Layer CLI --env flags (highest priority)
    for (const [k, v] of envPairs) {
      envVars[k] = v;
    }

    // Check for required manifest env vars without values
    if (m?.env) {
      const missing = m.env.filter((e) => e.required && !envVars[e.key]);
      if (missing.length > 0) {
        console.error(`${RED}Missing required environment variables:${RESET}`);
        for (const e of missing) {
          console.error(`  --env=${e.key}=<value>${e.description ? `  (${e.description})` : ""}`);
        }
        process.exit(1);
      }
    }

    if (Object.keys(envVars).length > 0) body.env_vars = envVars;
  }

  // Clean undefined values
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }

  console.log(`Deploying ${BOLD}${name}${RESET} from ${DIM}${repo}${RESET}...`);

  const { deployment_id } = await post<{ deployment_id: number }>("/api/apps/deploy", body);

  // Poll for progress
  let lastSeq = 0;
  while (true) {
    const poll = await get<DeployJobPoll>(`/api/deploy-jobs/${deployment_id}?since=${lastSeq}`);

    for (const event of poll.events) {
      const step = event.step.padEnd(14);
      if (event.step === "error") {
        console.log(`  ${RED}${step}${RESET} ${event.detail}`);
      } else if (event.step === "done") {
        console.log(`  ${GREEN}${step}${RESET} ${event.detail}`);
      } else {
        console.log(`  ${CYAN}${step}${RESET} ${event.detail}`);
      }
    }

    if (poll.events.length > 0) {
      lastSeq = poll.last_seq;
    }

    if (poll.status !== "running") {
      if (poll.result?.ok) {
        console.log(`\n${GREEN}Deploy complete!${RESET}`);
      } else {
        console.error(`\n${RED}Deploy failed: ${poll.result?.error || "unknown error"}${RESET}`);
        process.exit(1);
      }
      break;
    }
  }
}
