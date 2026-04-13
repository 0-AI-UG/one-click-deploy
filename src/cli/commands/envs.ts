import { get, post, put } from "../api.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, table } from "../format.ts";

interface Environment {
  id: number;
  name: string;
  env_vars: Array<{ key: string; value: string; secret: boolean }>;
}

interface LinkedApp {
  id: number;
  name: string;
  status: string;
  domain: string;
}

async function resolveEnv(nameOrId: string): Promise<Environment> {
  const list = await get<Environment[]>("/api/environments");

  const id = parseInt(nameOrId, 10);
  if (!isNaN(id)) {
    const env = list.find((e) => e.id === id);
    if (env) return env;
  }

  const lower = nameOrId.toLowerCase();
  const env = list.find((e) => e.name.toLowerCase() === lower);
  if (env) return env;

  console.error(`Environment not found: ${nameOrId}`);
  console.error(`Available: ${list.map((e) => e.name).join(", ") || "(none)"}`);
  process.exit(1);
}

async function listEnvs(): Promise<void> {
  const list = await get<Environment[]>("/api/environments");

  table(
    ["ID", "Name", "Variables"],
    list.map((e) => [
      String(e.id),
      e.name,
      String(e.env_vars?.length || 0),
    ]),
  );
}

async function showEnv(nameOrId: string): Promise<void> {
  const env = await resolveEnv(nameOrId);
  const apps = await get<LinkedApp[]>(`/api/environments/${env.id}/apps`);

  console.log(`${BOLD}${env.name}${RESET} ${DIM}(id: ${env.id})${RESET}\n`);

  if (env.env_vars?.length) {
    table(
      ["Key", "Value", "Secret"],
      env.env_vars.map((v) => [
        v.key,
        v.secret ? DIM + "••••••••" + RESET : v.value,
        v.secret ? YELLOW + "yes" + RESET : "no",
      ]),
    );
  } else {
    console.log(`${DIM}No variables${RESET}`);
  }

  if (apps.length > 0) {
    console.log(`\n${BOLD}Linked apps:${RESET} ${apps.map((a) => a.name).join(", ")}`);
  }
}

async function createEnv(name: string, varArgs: string[]): Promise<void> {
  const env_vars = parseVarArgs(varArgs);

  const result = await post<Environment>("/api/environments", { name, env_vars });
  console.log(`${GREEN}Created environment ${BOLD}${result.name}${RESET}${GREEN} (id: ${result.id})${RESET}`);
}

async function setVars(nameOrId: string, varArgs: string[]): Promise<void> {
  const env = await resolveEnv(nameOrId);
  const env_vars = parseVarArgs(varArgs);

  if (env_vars.length === 0) {
    console.error(`${RED}No variables provided. Use KEY=VALUE or --secret KEY=VALUE${RESET}`);
    process.exit(1);
  }

  const result = await put<{ ok: boolean; redeploying: number }>(`/api/environments/${env.id}`, {
    env_vars,
  });

  console.log(`${GREEN}Updated ${env.name}${RESET}`);
  if (result.redeploying > 0) {
    console.log(`${YELLOW}Redeploying ${result.redeploying} linked app(s)${RESET}`);
  }
}

function parseVarArgs(args: string[]): Array<{ key: string; value: string; secret: boolean }> {
  const vars: Array<{ key: string; value: string; secret: boolean }> = [];
  let nextSecret = false;

  for (const arg of args) {
    if (arg === "--secret") {
      nextSecret = true;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      vars.push({ key: arg.slice(0, eq), value: arg.slice(eq + 1), secret: nextSecret });
      nextSecret = false;
    }
  }

  return vars;
}

export async function envs(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "list") {
    await listEnvs();
    return;
  }

  if (sub === "show") {
    if (!args[1]) {
      console.error("Usage: ocd envs show <name|id>");
      process.exit(1);
    }
    await showEnv(args[1]);
    return;
  }

  if (sub === "create") {
    if (!args[1]) {
      console.error("Usage: ocd envs create <name> [KEY=VALUE ...] [--secret KEY=VALUE]");
      process.exit(1);
    }
    await createEnv(args[1], args.slice(2));
    return;
  }

  if (sub === "set") {
    if (!args[1]) {
      console.error("Usage: ocd envs set <name|id> KEY=VALUE [--secret KEY=VALUE] ...");
      process.exit(1);
    }
    await setVars(args[1], args.slice(2));
    return;
  }

  console.error(`${BOLD}Usage:${RESET} ocd envs <command>

${BOLD}Commands:${RESET}
  list                       List all environments
  show <name|id>             Show environment details and variables
  create <name> [vars...]    Create a new environment
  set <name|id> [vars...]    Set variables (redeploys linked apps)

${BOLD}Variable format:${RESET}
  KEY=VALUE                  Plain variable
  --secret KEY=VALUE         Secret variable (encrypted, not retrievable)`);
  process.exit(1);
}
