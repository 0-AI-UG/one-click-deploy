import path from "path";
import fs from "fs";

export interface CLIConfig {
  panel_url: string;
  token: string;
  username?: string;
}

function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || path.join(process.env.HOME || "~", ".config");
  return path.join(base, "ocd");
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function loadConfig(): CLIConfig | null {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as CLIConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: CLIConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function requireConfig(): CLIConfig {
  const envPanelUrl = process.env.OCD_PANEL_URL?.trim();
  const envToken = process.env.OCD_TOKEN?.trim();
  if (envPanelUrl || envToken) {
    if (!envPanelUrl || !envToken) {
      console.error("OCD_PANEL_URL and OCD_TOKEN must be set together.");
      process.exit(1);
    }
    return { panel_url: envPanelUrl.replace(/\/+$/, ""), token: envToken };
  }
  const config = loadConfig();
  if (!config || !config.token || !config.panel_url) {
    console.error("Not logged in. Run `ocd login <panel-url>` first.");
    process.exit(1);
  }
  return config;
}
