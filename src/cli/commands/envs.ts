import { get, post, put, del } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, table } from "../format.ts";
import { webConfirm } from "../confirm.ts";

interface Environment {
  id: number;
  name: string;
  env_vars: Array<{ key: string; value: string; secret: boolean }>;
  deleted_at?: string | null;
  purge_after?: string | null;
}

interface LinkedApp {
  id: number;
  name: string;
  status: string;
  domain: string;
}

type RolloutMode = "redeploy" | "restart" | "none";

async function rolloutOptions(
  envId: number,
  args: string[],
): Promise<{ args: string[]; rollout: RolloutMode; app_ids?: number[]; wait: boolean; json: boolean }> {
  let rollout: RolloutMode = "redeploy";
  let wait = true;
  let json = false;
  const selectors: string[] = [];
  const remaining: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--restart") {
      rollout = "restart";
    } else if (arg === "--no-rollout") {
      rollout = "none";
    } else if (arg === "--rollout") {
      const value = args[++i] || "";
      if (!["redeploy", "restart", "none"].includes(value)) {
        console.error("--rollout must be redeploy, restart, or none");
        process.exit(1);
      }
      rollout = value as RolloutMode;
    } else if (arg.startsWith("--rollout=")) {
      const value = arg.slice(10);
      if (!["redeploy", "restart", "none"].includes(value)) {
        console.error("--rollout must be redeploy, restart, or none");
        process.exit(1);
      }
      rollout = value as RolloutMode;
    } else if (arg === "--app") {
      selectors.push(args[++i] || "");
    } else if (arg.startsWith("--app=")) {
      selectors.push(arg.slice(6));
    } else if (arg === "--async" || arg === "--no-wait") {
      wait = false;
    } else if (arg === "--wait") {
      wait = true;
    } else if (arg === "--json") {
      json = true;
    } else {
      remaining.push(arg);
    }
  }
  if (selectors.length === 0) return { args: remaining, rollout, wait, json };
  const linked = await get<LinkedApp[]>(`/api/environments/${envId}/apps`);
  const appIds = selectors.map((selector) => {
    const id = parseInt(selector, 10);
    const match = Number.isInteger(id)
      ? linked.find((app) => app.id === id)
      : linked.find((app) => app.name.toLowerCase() === selector.toLowerCase());
    if (!match) {
      console.error(`Linked app not found: ${selector}`);
      process.exit(1);
    }
    return match.id;
  });
  return { args: remaining, rollout, app_ids: [...new Set(appIds)], wait, json };
}

function printRollout(result: { redeploying?: number; restarting?: number; affected?: number; rollout?: string }) {
  if ((result.redeploying || 0) > 0) {
    console.log(`${YELLOW}Redeploying ${result.redeploying} linked app(s)${RESET}`);
  } else if ((result.restarting || 0) > 0) {
    console.log(`${YELLOW}Reloading ${result.restarting} linked app(s) from existing images${RESET}`);
  } else if (result.rollout === "none" && (result.affected || 0) > 0) {
    console.log(`${DIM}No rollout requested; ${result.affected} app(s) will pick up values on their next recreate.${RESET}`);
  }
}

async function finishRollout(
  result: { op_id?: number | null },
  wait: boolean,
  quiet = false,
): Promise<{ status: "not_queued" | "queued" | "done"; error?: string }> {
  if (result.op_id == null) return { status: "not_queued" };
  if (!wait) {
    if (!quiet) console.log(`${DIM}Queued operation #${result.op_id}. Follow it with: ocd ops logs ${result.op_id} --follow${RESET}`);
    return { status: "queued" };
  }
  const op = await followOp(result.op_id, { quiet });
  if (!op.ok) {
    return { status: "done", error: op.error || "a child operation failed" };
  }
  if (!quiet) console.log(`${GREEN}Environment rollout complete.${RESET}`);
  return { status: "done" };
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

async function resolveDeletedEnv(nameOrId: string): Promise<Environment> {
  const list = await get<Environment[]>("/api/environments/deleted");
  const id = parseInt(nameOrId, 10);
  const environment = Number.isInteger(id)
    ? list.find((item) => item.id === id)
    : list.find((item) => item.name.toLowerCase() === nameOrId.toLowerCase());
  if (environment) return environment;
  throw new Error(`Deleted environment not found: ${nameOrId}`);
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

async function listDeletedEnvs(): Promise<void> {
  const list = await get<Environment[]>("/api/environments/deleted");
  table(
    ["ID", "Name", "Deleted", "Recoverable until"],
    list.map((environment) => [
      String(environment.id),
      environment.name,
      environment.deleted_at || "",
      environment.purge_after || "",
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
  const env_vars = await parseVarArgs(varArgs);

  const result = await post<Environment>("/api/environments", { name, env_vars });
  console.log(`${GREEN}Created environment ${BOLD}${result.name}${RESET}${GREEN} (id: ${result.id})${RESET}`);
}

async function copyEnv(nameOrId: string, newName: string): Promise<void> {
  const env = await resolveEnv(nameOrId);
  const result = await post<Environment>(`/api/environments/${env.id}/copy`, { name: newName });
  console.log(`${GREEN}Copied ${BOLD}${env.name}${RESET}${GREEN} → ${BOLD}${result.name}${RESET}${GREEN} (id: ${result.id})${RESET}`);
}

async function renameEnv(nameOrId: string, newName: string): Promise<void> {
  const env = await resolveEnv(nameOrId);
  await put(`/api/environments/${env.id}`, { name: newName });
  console.log(`${GREEN}Renamed ${BOLD}${env.name}${RESET}${GREEN} → ${BOLD}${newName}${RESET}`);
}

async function setVars(nameOrId: string, varArgs: string[]): Promise<void> {
  const env = await resolveEnv(nameOrId);
  const options = await rolloutOptions(env.id, varArgs);
  const replace = options.args.includes("--replace");
  const filtered = options.args.filter((a) => a !== "--replace");
  const incoming = await parseVarArgs(filtered);

  if (incoming.length === 0) {
    console.error(`${RED}No variables provided. Use KEY=VALUE or --secret KEY=VALUE${RESET}`);
    process.exit(1);
  }

  // Merge with existing vars by default — the API PUT replaces the whole set,
  // so we have to send everything we want to keep. Use `--replace` to opt out.
  const env_vars = replace ? incoming : mergeWithExisting(env.env_vars || [], incoming);

  const result = await put<{ ok: boolean; redeploying: number; restarting: number; affected: number; rollout: string; op_id: number | null }>(`/api/environments/${env.id}`, {
    env_vars,
    rollout: options.rollout,
    app_ids: options.app_ids,
  });

  if (!options.json) {
    console.log(`${GREEN}Updated ${env.name}${RESET} ${DIM}(${incoming.map((v) => v.key).join(", ")})${RESET}`);
    printRollout(result);
  }
  const terminal = await finishRollout(result, options.wait, options.json);
  if (options.json) {
    console.log(JSON.stringify({
      ok: !terminal.error,
      environment: { id: env.id, name: env.name },
      changed_keys: incoming.map((v) => v.key),
      rollout: result.rollout,
      affected: result.affected,
      op_id: result.op_id,
      status: terminal.status,
      error: terminal.error ?? null,
    }));
  }
  if (terminal.error) throw new Error(`Environment rollout failed: ${terminal.error}`);
}

async function unsetVars(nameOrId: string, keys: string[]): Promise<void> {
  const env = await resolveEnv(nameOrId);
  const options = await rolloutOptions(env.id, keys);
  const remove = new Set(options.args);
  const existing = env.env_vars || [];
  const missing = options.args.filter((k) => !existing.find((v) => v.key === k));
  if (missing.length) {
    console.error(`${YELLOW}Not set: ${missing.join(", ")}${RESET}`);
  }
  const kept = existing.filter((v) => !remove.has(v.key));

  if (kept.length === existing.length) {
    if (options.json) {
      console.log(JSON.stringify({
        ok: true,
        environment: { id: env.id, name: env.name },
        changed_keys: [],
        rollout: options.rollout,
        affected: 0,
        op_id: null,
        status: "not_queued",
        error: null,
      }));
    } else {
      console.log(`${DIM}No changes${RESET}`);
    }
    return;
  }

  const result = await put<{ ok: boolean; redeploying: number; restarting: number; affected: number; rollout: string; op_id: number | null }>(`/api/environments/${env.id}`, {
    env_vars: kept,
    rollout: options.rollout,
    app_ids: options.app_ids,
  });

  const changedKeys = options.args.filter((k) => !missing.includes(k));
  if (!options.json) {
    console.log(`${GREEN}Updated ${env.name}${RESET} ${DIM}(removed ${changedKeys.join(", ")})${RESET}`);
    printRollout(result);
  }
  const terminal = await finishRollout(result, options.wait, options.json);
  if (options.json) {
    console.log(JSON.stringify({
      ok: !terminal.error,
      environment: { id: env.id, name: env.name },
      changed_keys: changedKeys,
      rollout: result.rollout,
      affected: result.affected,
      op_id: result.op_id,
      status: terminal.status,
      error: terminal.error ?? null,
    }));
  }
  if (terminal.error) throw new Error(`Environment rollout failed: ${terminal.error}`);
}

function mergeWithExisting(
  existing: Array<{ key: string; value: string; secret: boolean }>,
  incoming: Array<{ key: string; value: string; secret: boolean }>,
): Array<{ key: string; value: string; secret: boolean }> {
  const byKey = new Map(existing.map((v) => [v.key, v]));
  for (const item of incoming) byKey.set(item.key, item);
  return Array.from(byKey.values());
}

export async function parseVarArgs(args: string[]): Promise<Array<{ key: string; value: string; secret: boolean }>> {
  const vars: Array<{ key: string; value: string; secret: boolean }> = [];
  let nextSecret = false;

  const add = (key: string, value: string, secret: boolean) => {
    if (!key) throw new Error("Variable key cannot be empty");
    if (!secret && /(?:PASSWORD|PASSWD|TOKEN|SECRET|SECRET_KEY|SECRET_ACCESS_KEY|CLIENT_SECRET|PRIVATE_KEY|API_KEY|ACCESS_KEY(?:_ID)?|CREDENTIALS?|DATABASE_URL|REDIS_URL|MONGO_URL|CONNECTION_(?:STRING|URL)|DSN)$/i.test(key)) {
      console.error(`${YELLOW}Warning: ${key} looks sensitive; the server will store it as an encrypted secret automatically.${RESET}`);
    }
    vars.push({ key, value, secret });
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--secret") {
      nextSecret = true;
      continue;
    }
    if (arg === "--secret-file") {
      const spec = args[++i] || "";
      const eq = spec.indexOf("=");
      if (eq < 1) throw new Error("--secret-file expects KEY=PATH");
      const value = (await Bun.file(spec.slice(eq + 1)).text()).replace(/\r?\n$/, "");
      add(spec.slice(0, eq), value, true);
      continue;
    }
    if (arg.startsWith("--secret-file=")) {
      const spec = arg.slice(14);
      const eq = spec.indexOf("=");
      if (eq < 1) throw new Error("--secret-file expects KEY=PATH");
      const value = (await Bun.file(spec.slice(eq + 1)).text()).replace(/\r?\n$/, "");
      add(spec.slice(0, eq), value, true);
      continue;
    }
    if (arg === "--secret-stdin") {
      const key = args[++i] || "";
      if (!key) throw new Error("--secret-stdin expects KEY");
      add(key, (await Bun.stdin.text()).replace(/\r?\n$/, ""), true);
      continue;
    }
    if (arg === "--from-env" || arg.startsWith("--from-env=")) {
      const spec = arg === "--from-env" ? (args[++i] || "") : arg.slice(11);
      const eq = spec.indexOf("=");
      const key = eq === -1 ? spec : spec.slice(0, eq);
      const source = eq === -1 ? spec : spec.slice(eq + 1);
      if (!key || !source) throw new Error("--from-env expects KEY or KEY=ENV_NAME");
      const value = process.env[source];
      if (value === undefined) throw new Error(`Environment variable ${source} is not set`);
      add(key, value, true);
      continue;
    }
    if (arg === "--from-dotenv" || arg.startsWith("--from-dotenv=")) {
      const path = arg === "--from-dotenv" ? (args[++i] || "") : arg.slice(14);
      if (!path) throw new Error("--from-dotenv expects a file path");
      const text = await Bun.file(path).text();
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const normalized = line.startsWith("export ") ? line.slice(7) : line;
        const eq = normalized.indexOf("=");
        if (eq < 1) throw new Error(`Invalid dotenv line in ${path}: ${raw}`);
        let value = normalized.slice(eq + 1).trim();
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1);
        }
        add(normalized.slice(0, eq).trim(), value, true);
      }
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      add(arg.slice(0, eq), arg.slice(eq + 1), nextSecret);
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

  if (sub === "copy" || sub === "duplicate") {
    if (!args[1] || !args[2]) {
      console.error("Usage: ocd envs copy <name|id> <new-name>");
      process.exit(1);
    }
    await copyEnv(args[1], args[2]);
    return;
  }

  if (sub === "rename") {
    if (!args[1] || !args[2]) {
      console.error("Usage: ocd envs rename <name|id> <new-name>");
      process.exit(1);
    }
    await renameEnv(args[1], args[2]);
    return;
  }

  if (sub === "set") {
    if (!args[1]) {
      console.error("Usage: ocd envs set <name|id> KEY=VALUE [--secret KEY=VALUE] ... [--replace]");
      process.exit(1);
    }
    await setVars(args[1], args.slice(2));
    return;
  }

  if (sub === "unset") {
    if (!args[1] || args.length < 3) {
      console.error("Usage: ocd envs unset <name|id> KEY [KEY...]");
      process.exit(1);
    }
    await unsetVars(args[1], args.slice(2));
    return;
  }

  if (sub === "deleted" || sub === "trash") {
    await listDeletedEnvs();
    return;
  }

  if (sub === "restore") {
    if (!args[1]) {
      console.error("Usage: ocd envs restore <name|id>");
      process.exit(1);
    }
    const environment = await resolveDeletedEnv(args[1]);
    await post(`/api/environments/${environment.id}/restore`);
    console.log(`${GREEN}Restored environment ${BOLD}${environment.name}${RESET}`);
    return;
  }

  if (sub === "purge") {
    if (!args[1]) {
      console.error("Usage: ocd envs purge <name|id>");
      process.exit(1);
    }
    const environment = await resolveDeletedEnv(args[1]);
    const confirmation = await webConfirm("purge_environment", "environment", environment.id);
    if (!confirmation) {
      console.log("Aborted.");
      return;
    }
    await del(`/api/environments/${environment.id}/purge`, undefined, { "X-OCD-Confirmation": confirmation });
    console.log(`${GREEN}Permanently deleted environment ${BOLD}${environment.name}${RESET}`);
    return;
  }

  if (sub === "remove" || sub === "delete") {
    if (!args[1]) {
      console.error("Usage: ocd envs remove <name|id>");
      process.exit(1);
    }
    const env = await resolveEnv(args[1]);
    const copyFlag = args.slice(2).find((arg) => arg === "--copy-before-delete" || arg.startsWith("--copy-before-delete="));
    const copyName = copyFlag
      ? (copyFlag.includes("=")
        ? copyFlag.slice(copyFlag.indexOf("=") + 1)
        : `${env.name}-backup-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`)
      : null;
    if (copyFlag?.includes("=") && !copyName) {
      throw new Error("--copy-before-delete requires a non-empty name");
    }
    const confirm = await webConfirm(
      "delete_environment",
      "environment",
      env.id,
    );
    if (!confirm) {
      console.log("Aborted.");
      return;
    }
    if (copyName) {
      await post(`/api/environments/${env.id}/copy`, { name: copyName });
      console.log(`${GREEN}Created recovery copy ${BOLD}${copyName}${RESET}`);
    }
    const result = await del<{ recoverable_until?: string | null }>(
      `/api/environments/${env.id}`,
      undefined,
      { "X-OCD-Confirmation": confirm },
    );
    console.log(
      `${GREEN}Retired environment ${BOLD}${env.name}${RESET}${GREEN}; it can be restored` +
      `${result.recoverable_until
        ? ` and is protected from permanent deletion until ${result.recoverable_until}`
        : " from the deleted-environments list"}.${RESET}`,
    );
    return;
  }

  console.error(`${BOLD}Usage:${RESET} ocd envs <command>

${BOLD}Commands:${RESET}
  list                       List all environments
  show <name|id>             Show environment details and variables
  create <name> [vars...]    Create a new environment
  copy <name|id> <new-name>  Duplicate an environment (secrets included)
  rename <name|id> <new-name> Rename an environment without changing variables
  set <name|id> [vars...]    Merge variables into env
  unset <name|id> KEY...     Remove variables from env
  deleted                    List recoverable deleted environments
  restore <name|id>          Restore a deleted environment
  remove <name|id>           Retire an unused environment for recovery (web approval)
  purge <name|id>            Permanently delete a retired environment (web approval)

${BOLD}Variable format:${RESET}
  KEY=VALUE                  Plain variable
  --secret KEY=VALUE         Secret variable (encrypted, not retrievable)
  --secret-file KEY=PATH     Read one secret without putting its value in argv
  --secret-stdin KEY         Read one secret from stdin
  --from-env KEY[=ENV_NAME]  Read a secret from the local process environment
  --from-dotenv PATH         Import dotenv entries as secrets
  --replace                  With set: replace all vars instead of merging
  --rollout=MODE             redeploy (default), restart (no build), or none
  --app=<name|id>            Limit rollout to a linked app (repeatable)
  --restart                  Alias for --rollout=restart
  --no-rollout               Alias for --rollout=none
  --async, --no-wait         Queue the rollout instead of waiting for child apps
  --wait                     Wait for the full cascade (default; child failure fails CLI)`);
  process.exit(1);
}
