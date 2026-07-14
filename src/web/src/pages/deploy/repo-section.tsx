import { useState } from "react";
import { Loader2, Check, AlertTriangle, Copy } from "lucide-react";
import { Field } from "../../components/ui.tsx";
import type { IntrospectResult, FormState } from "./types.ts";

/** Prompt the user pastes into their own coding agent. The agent installs the
 *  OCD skill via the `ocd` CLI, choosing the --agent value that matches itself,
 *  then follows the skill to configure a manifest and deploy this repo. */
function agentSetupPrompt(): string {
  const panel = window.location.origin;
  return `Set up the One-Click Deploy (OCD) skill so you can deploy this repo for me.

OCD is a self-hosted Hetzner PaaS. Panel: ${panel}

Do this:
1. If the \`ocd\` CLI isn't installed, install it and log in:
   curl -fsSL ${panel}/cli/install.sh | sh
   ocd login ${panel}
2. Figure out which coding agent you are and pick the matching value:
   claude (Claude Code), codex (OpenAI Codex), cursor (Cursor),
   antigravity (Google Antigravity), opencode (OpenCode), pi (pi).
   If you're none of these, use claude.
3. From this repo's root, install the skill:
   ocd skill install --agent <that-value>
4. Read the installed SKILL.md and follow it to write an \`.ocd-deploy.json\`
   (or \`ocd-stack.json\`) for this repo and deploy it with \`ocd deploy\`.`;
}

function AgentPromptButton() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(agentSetupPrompt());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      title="Copy a prompt to paste into your AI coding agent — it installs the OCD skill and deploys this repo for you"
      className="flex items-center gap-1 text-[9px] text-fg-dim hover:text-fg transition-colors uppercase tracking-wider"
    >
      {copied ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
      {copied ? "Copied" : "Deploy with your agent"}
    </button>
  );
}

type Props = {
  form: FormState;
  set: (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  introspecting: boolean;
  introspect: IntrospectResult | null;
};

export function RepoSection({ form, set, introspecting, introspect }: Props) {
  const detected = introspect?.ok === true && introspect.kind === "app" ? introspect : null;
  const stack = introspect?.ok === true && introspect.kind === "stack" ? introspect.stack : null;

  return (
    <div className="p-5">
      <Field label="Git Repository">
        <input
          type="text"
          value={form.git_repo}
          onChange={set("git_repo")}
          placeholder="https://github.com/user/repo"
          required
          autoFocus
          className="!text-[12px] !py-3"
        />
      </Field>

      <div className="mt-3 min-h-[18px] flex items-center justify-between font-mono text-[10px]">
        <div className="flex items-center gap-2">
          {introspecting && (
            <>
              <Loader2 size={12} className="animate-spin text-fg" />
              <span className="text-fg-dim">Peeking at the repo</span>
            </>
          )}
          {!introspecting && stack && (
            <>
              <Check size={12} strokeWidth={3} className="text-fg bg-accent border-2 border-fg" />
              <span className="text-fg">
                Stack · {stack.apps.length} app{stack.apps.length === 1 ? "" : "s"}
                {stack.services.length > 0
                  ? ` · ${stack.services.length} service${stack.services.length === 1 ? "" : "s"}`
                  : ""}
              </span>
            </>
          )}
          {!introspecting && detected && (
            <>
              <Check size={12} strokeWidth={3} className="text-fg bg-accent border-2 border-fg" />
              <span className="text-fg">
                {detected.manifests.length > 0
                  ? detected.manifests.length === 1
                    ? `Deploy manifest found`
                    : `${detected.manifests.length} deploy manifests found`
                  : <>
                      Found {detected.dockerfiles.length > 0 ? "Dockerfile" : "repo"}
                      {detected.detected_port ? ` · port ${detected.detected_port}` : ""}
                      {detected.env_vars.length > 0
                        ? ` · ${detected.env_vars.length} env var${detected.env_vars.length === 1 ? "" : "s"}`
                        : ""}
                    </>}
              </span>
            </>
          )}
          {!introspecting && introspect && !introspect.ok && (
            <>
              <AlertTriangle size={12} className="text-accent-red" />
              <span className="text-fg-dim">{introspect.error}</span>
            </>
          )}
        </div>
        <AgentPromptButton />
      </div>
    </div>
  );
}
