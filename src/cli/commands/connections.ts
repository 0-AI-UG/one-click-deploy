import { del, get, put } from "../api.ts";
import { promptHidden, promptLine } from "../prompt.ts";
import { BOLD, DIM, GREEN, RESET } from "../format.ts";

type Connections = {
  registry: { connected: boolean; scope: string; username: string; token: string };
  source: { connected: boolean; host: string; username: string; token: string };
};

function flag(args: string[], name: string): string | undefined {
  const equal = args.find((arg) => arg.startsWith(`--${name}=`));
  if (equal) return equal.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--username" || value === "--token-env") { index++; continue; }
    if (!value.startsWith("-")) return value;
  }
  return undefined;
}

async function secret(args: string[], defaultEnv: string, label: string): Promise<string> {
  if (args.includes("--token-stdin")) return (await Bun.stdin.text()).trim();
  const envName = flag(args, "token-env");
  if (envName) return process.env[envName]?.trim() || "";
  if (process.env[defaultEnv]) return process.env[defaultEnv]!.trim();
  return promptHidden(`${label}: `);
}

async function status(kind: "registry" | "source") {
  const connections = await get<Connections>("/api/admin/connections");
  const value = connections[kind];
  console.log(`${BOLD}${kind === "registry" ? "OCI registry" : "Git source"}${RESET}: ${value.connected ? `${GREEN}connected${RESET}` : "not connected"}`);
  if (kind === "registry") console.log(`${DIM}Scope:${RESET} ${(value as Connections["registry"]).scope || "-"}`);
  else console.log(`${DIM}Host:${RESET} ${(value as Connections["source"]).host}`);
  console.log(`${DIM}Username:${RESET} ${value.username || "-"}`);
}

export async function registry(args: string[]): Promise<void> {
  const sub = args[0] || "status";
  if (sub === "status") return status("registry");
  if (sub === "logout" || sub === "disconnect") {
    await del("/api/admin/connections/registry");
    console.log(`${GREEN}Registry connection removed.${RESET}`);
    return;
  }
  if (sub !== "login" && sub !== "connect") throw new Error("Usage: ocd registry <status|login|logout>");
  const rest = args.slice(1);
  const scope = positional(rest) || await promptLine("Registry namespace (for example ghcr.io/acme): ");
  const username = flag(rest, "username") || await promptLine("Registry username: ");
  const token = await secret(rest, "OCD_REGISTRY_TOKEN", "Registry password/token");
  if (!token) throw new Error("Registry password/token is required");
  await put("/api/admin/connections/registry", { scope, username, token });
  console.log(`${GREEN}Registry connected for ${scope}.${RESET}`);
}

export async function source(args: string[]): Promise<void> {
  const sub = args[0] || "status";
  if (sub === "status") return status("source");
  if (sub === "logout" || sub === "disconnect") {
    await del("/api/admin/connections/source");
    console.log(`${GREEN}Source connection removed. Public repositories remain available.${RESET}`);
    return;
  }
  if (sub !== "login" && sub !== "connect") throw new Error("Usage: ocd source <status|login|logout>");
  const rest = args.slice(1);
  const host = positional(rest) || "github.com";
  const username = flag(rest, "username") || "x-access-token";
  const token = await secret(rest, "OCD_SOURCE_TOKEN", "Read-only source token");
  if (!token) throw new Error("Source token is required");
  await put("/api/admin/connections/source", { host, username, token });
  console.log(`${GREEN}Source access connected for ${host}.${RESET}`);
}
