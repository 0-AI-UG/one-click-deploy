export type SkillAgentTarget = {
  name: string;
  aliases: readonly string[];
  /** Directory that holds `<skill-name>/SKILL.md`, relative to the install root. */
  skillsDir: string;
  label: string;
};

/** Canonical targets supported by `ocd skill install` and the panel copy UI. */
export const SKILL_AGENT_TARGETS: readonly SkillAgentTarget[] = [
  { name: "claude", aliases: ["claude-code", "claudecode"], skillsDir: ".claude/skills", label: "Claude Code" },
  { name: "codex", aliases: [], skillsDir: ".agents/skills", label: "OpenAI Codex" },
  { name: "cursor", aliases: [], skillsDir: ".cursor/skills", label: "Cursor" },
  { name: "antigravity", aliases: ["agy", "gemini"], skillsDir: ".agents/skills", label: "Google Antigravity" },
  { name: "opencode", aliases: ["open-code"], skillsDir: ".opencode/skills", label: "OpenCode" },
  { name: "pi", aliases: [], skillsDir: ".pi/skills", label: "pi" },
];

export function resolveSkillAgent(input: string): SkillAgentTarget | undefined {
  const key = input.toLowerCase();
  return SKILL_AGENT_TARGETS.find(
    (agent) => agent.name === key || agent.aliases.includes(key),
  );
}
