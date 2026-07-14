// The `ocd-deploy` Agent Skill, embedded into the compiled `ocd` binary.
//
// The files under ./assets are imported as raw text (`with { type: "text" }`),
// which `bun build --compile` inlines as string literals — so the standalone
// binary can write the skill to disk without reading any external file. Editing
// an asset file is all it takes to update the shipped skill; keep the schema
// bits in sync with src/shared/manifest-schema.ts.
//
// `renderSkillFiles()` returns the skill as a map of {relativePath -> contents}
// where the path is relative to the installed skill directory (e.g.
// `.claude/skills/ocd-deploy/`). The `{{PANEL_URL}}` placeholder is substituted
// per-install so the CLI install command points at the user's own panel.

import SKILL_MD from "./assets/SKILL.md" with { type: "text" };
import REFERENCE_MD from "./assets/reference.md" with { type: "text" };
import EX_SINGLE from "./assets/ex-single.deploy.jsonc" with { type: "text" };
import EX_API from "./assets/ex-api.deploy.jsonc" with { type: "text" };
import EX_WEB from "./assets/ex-web.deploy.jsonc" with { type: "text" };
import EX_STACK from "./assets/ex-stack.stack.jsonc" with { type: "text" };
import EX_WORKER from "./assets/ex-worker.deploy.jsonc" with { type: "text" };

/** The directory name every agent installs the skill under. */
export const SKILL_DIR_NAME = "ocd-deploy";

/** Source text keyed by the path it should be written to, relative to the
 *  installed skill directory. Order is stable so install output is tidy. */
const RAW_FILES: ReadonlyArray<readonly [string, string]> = [
  ["SKILL.md", SKILL_MD],
  ["reference.md", REFERENCE_MD],
  ["examples/single-service/.ocd-deploy.json", EX_SINGLE],
  ["examples/monorepo/ocd-stack.json", EX_STACK],
  ["examples/monorepo/services/api/.ocd-deploy.json", EX_API],
  ["examples/monorepo/services/web/.ocd-deploy.json", EX_WEB],
  ["examples/worker/.ocd-deploy.json", EX_WORKER],
];

/**
 * Render the skill's files with panel-specific placeholders substituted.
 * @param panelUrl the logged-in panel's base URL, or undefined when not logged
 *   in (the placeholder then falls back to a generic hint).
 */
export function renderSkillFiles(panelUrl?: string): Array<{ path: string; contents: string }> {
  const panel = panelUrl?.replace(/\/+$/, "") || "https://your-panel.example.com";
  return RAW_FILES.map(([path, contents]) => ({
    path,
    contents: contents.replaceAll("{{PANEL_URL}}", panel),
  }));
}
