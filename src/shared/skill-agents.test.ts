import { describe, expect, test } from "bun:test";
import { SKILL_AGENT_TARGETS, resolveSkillAgent } from "./skill-agents.ts";

describe("skill agent targets", () => {
  test("keeps canonical names and aliases unique and resolvable", () => {
    const names = SKILL_AGENT_TARGETS.flatMap((agent) => [
      agent.name,
      ...agent.aliases,
    ]);
    expect(new Set(names).size).toBe(names.length);

    for (const agent of SKILL_AGENT_TARGETS) {
      expect(resolveSkillAgent(agent.name)).toBe(agent);
      for (const alias of agent.aliases) {
        expect(resolveSkillAgent(alias)).toBe(agent);
      }
    }
  });
});
