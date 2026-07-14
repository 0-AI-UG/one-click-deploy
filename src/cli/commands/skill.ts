import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "../config.ts";
import { renderSkillFiles, SKILL_DIR_NAME } from "../skill/content.ts";
import { BOLD, DIM, GREEN, RESET } from "../format.ts";

/** A supported target agent: its canonical name, any aliases the user may type,
 *  the base directory (relative to the install root) it discovers skills in,
 *  and a human label for the summary. */
interface AgentTarget {
  name: string;
  aliases: string[];
  /** Directory that holds `<skill-name>/SKILL.md`, relative to the install root. */
  skillsDir: string;
  label: string;
}

// Every supported agent discovers skills as `<dir>/<name>/SKILL.md`; only the
// parent directory differs. (Codex and Antigravity both use `.agents/skills`;
// OpenCode also auto-discovers that path.) Keep this table as the single source
// of truth — adding an agent is one row.
const AGENTS: AgentTarget[] = [
  { name: "claude", aliases: ["claude-code", "claudecode"], skillsDir: ".claude/skills", label: "Claude Code" },
  { name: "codex", aliases: [], skillsDir: ".agents/skills", label: "OpenAI Codex" },
  { name: "cursor", aliases: [], skillsDir: ".cursor/skills", label: "Cursor" },
  { name: "antigravity", aliases: ["agy", "gemini"], skillsDir: ".agents/skills", label: "Google Antigravity" },
  { name: "opencode", aliases: ["open-code"], skillsDir: ".opencode/skills", label: "OpenCode" },
  { name: "pi", aliases: [], skillsDir: ".pi/skills", label: "pi" },
];

function resolveAgent(input: string): AgentTarget | undefined {
  const key = input.toLowerCase();
  return AGENTS.find((a) => a.name === key || a.aliases.includes(key));
}

function agentList(): string {
  return AGENTS.map((a) => {
    const names = [a.name, ...a.aliases].join(", ");
    return `  ${a.name.padEnd(14)} ${DIM}${a.label} → ${a.skillsDir}/${SKILL_DIR_NAME}/${RESET}${a.aliases.length ? `  ${DIM}(aka ${a.aliases.join(", ")})${RESET}` : ""}`;
  }).join("\n");
}

function printUsage(): void {
  console.log(`${BOLD}ocd skill${RESET}: install the OCD deploy skill into a project for your AI coding agent

${BOLD}Usage:${RESET}
  ocd skill install --agent <agent> [--dir <path>] [--force]
  ocd skill list

${BOLD}Options:${RESET}
  --agent <agent>   Target agent (required). One of the names below.
  --dir <path>      Install root (default: current directory).
  --force           Overwrite existing skill files.

${BOLD}Agents:${RESET}
${agentList()}

The skill is written to <root>/<agent-dir>/${SKILL_DIR_NAME}/ (SKILL.md, reference.md,
and example manifests). Run it from the repo you want the agent to understand.`);
}

function parseFlags(args: string[]): {
  agent?: string;
  dir?: string;
  force: boolean;
  help: boolean;
} {
  let agent: string | undefined;
  let dir: string | undefined;
  let force = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--force" || arg === "-f") force = true;
    else if (arg.startsWith("--agent=")) agent = arg.slice("--agent=".length);
    else if (arg === "--agent") agent = args[++i];
    else if (arg.startsWith("--dir=")) dir = arg.slice("--dir=".length);
    else if (arg === "--dir") dir = args[++i];
    else if (!arg.startsWith("-") && !agent) agent = arg; // allow `--agent`-less positional
    else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }
  return { agent, dir, force, help };
}

function install(args: string[]): void {
  const { agent, dir, force, help } = parseFlags(args);
  if (help) return printUsage();

  if (!agent) {
    console.error("Missing --agent. Choose one of:\n" + agentList());
    console.error(`\nExample: ocd skill install --agent claude`);
    process.exit(1);
  }

  const target = resolveAgent(agent);
  if (!target) {
    console.error(`Unknown agent: ${agent}\n\nSupported agents:\n${agentList()}`);
    process.exit(1);
  }

  const root = path.resolve(dir || process.cwd());
  const skillRoot = path.join(root, target.skillsDir, SKILL_DIR_NAME);

  // Best-effort: seed the CLI install URL in the docs from the logged-in panel.
  const panelUrl = loadConfig()?.panel_url;
  const files = renderSkillFiles(panelUrl);

  // Refuse to clobber unless --force, so a customized skill isn't lost.
  if (!force && fs.existsSync(skillRoot)) {
    console.error(
      `Skill already installed at ${DIM}${path.relative(root, skillRoot) || skillRoot}${RESET}. Re-run with --force to overwrite.`,
    );
    process.exit(1);
  }

  for (const file of files) {
    const dest = path.join(skillRoot, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.contents);
  }

  const rel = path.relative(root, skillRoot) || skillRoot;
  console.log(`${GREEN}✓${RESET} Installed the ${BOLD}${SKILL_DIR_NAME}${RESET} skill for ${target.label}`);
  console.log(`  ${DIM}${rel}/${RESET}`);
  for (const file of files) console.log(`  ${DIM}  ${file.path}${RESET}`);
  if (!panelUrl) {
    console.log(
      `\n${DIM}Tip: run \`ocd login <panel-url>\` before installing to pre-fill the panel URL in the example manifests.${RESET}`,
    );
  }
  console.log(`\n${target.label} will pick up the skill automatically in ${BOLD}${root}${RESET}.`);
}

export async function skill(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") return printUsage();
  if (sub === "list" || sub === "ls" || sub === "agents") {
    console.log(`${BOLD}Supported agents:${RESET}\n${agentList()}`);
    return;
  }
  if (sub === "install" || sub === "add") return install(args.slice(1));
  console.error(`Unknown skill subcommand: ${sub}`);
  printUsage();
  process.exit(1);
}
