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
import DOC_CONCEPTS from "./assets/docs/concepts.md" with { type: "text" };
import DOC_APP_MANIFEST from "./assets/docs/app-manifest.md" with { type: "text" };
import DOC_STACK_MANIFEST from "./assets/docs/stack-manifest.md" with { type: "text" };
import DOC_CLI_REFERENCE from "./assets/docs/cli-reference.md" with { type: "text" };
import DOC_DEPLOY_CONFIG from "./assets/docs/deploy-and-config.md" with { type: "text" };
import DOC_ENVIRONMENTS from "./assets/docs/environments-and-secrets.md" with { type: "text" };
import DOC_STACKS_SERVICES from "./assets/docs/stacks-and-services.md" with { type: "text" };
import DOC_NETWORKING from "./assets/docs/networking-and-ingress.md" with { type: "text" };
import DOC_SCALING_STORAGE from "./assets/docs/scaling-storage-and-placement.md" with { type: "text" };
import DOC_WEBHOOKS from "./assets/docs/webhooks-and-promotion.md" with { type: "text" };
import DOC_OPERATIONS from "./assets/docs/operations-and-recovery.md" with { type: "text" };
import DOC_SECURITY from "./assets/docs/security-and-deletion.md" with { type: "text" };
import DOC_TROUBLESHOOTING from "./assets/docs/troubleshooting.md" with { type: "text" };
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
  ["docs/concepts.md", DOC_CONCEPTS],
  ["docs/app-manifest.md", DOC_APP_MANIFEST],
  ["docs/stack-manifest.md", DOC_STACK_MANIFEST],
  ["docs/cli-reference.md", DOC_CLI_REFERENCE],
  ["docs/deploy-and-config.md", DOC_DEPLOY_CONFIG],
  ["docs/environments-and-secrets.md", DOC_ENVIRONMENTS],
  ["docs/stacks-and-services.md", DOC_STACKS_SERVICES],
  ["docs/networking-and-ingress.md", DOC_NETWORKING],
  ["docs/scaling-storage-and-placement.md", DOC_SCALING_STORAGE],
  ["docs/webhooks-and-promotion.md", DOC_WEBHOOKS],
  ["docs/operations-and-recovery.md", DOC_OPERATIONS],
  ["docs/security-and-deletion.md", DOC_SECURITY],
  ["docs/troubleshooting.md", DOC_TROUBLESHOOTING],
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
