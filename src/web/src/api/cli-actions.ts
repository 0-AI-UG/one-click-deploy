import { post } from "./client.ts";
import { getToken, logout } from "../stores/auth.ts";
import type { WebCliValues } from "../../../shared/web-cli.ts";

export type CliActionResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export type CliActionWorkspace = {
  entry: string;
  files: Array<{ path: string; content: string }>;
};

export type ConfirmableCliAction =
  | "delete_app"
  | "delete_server"
  | "delete_stack"
  | "delete_environment"
  | "purge_environment"
  | "delete_volume"
  | "cancel_operation"
  | "create_server"
  | "promote_app"
  | "promote_stack";

type Confirmation = { confirm_code: string; user_code: string };

/** Create and approve the same resource-bound, single-use confirmation used by
 * the local CLI. The code is consumed by the API call made from the spawned CLI
 * process, so the command gateway cannot broaden it to another action/resource. */
export async function approveCliAction(
  action: ConfirmableCliAction,
  resourceType: string,
  resourceId: string | number,
  typedResource?: string,
): Promise<string> {
  const confirmation = await post("/api/confirmations", {
    action,
    resource_type: resourceType,
    resource_id: resourceId,
  }) as Confirmation;
  const typedBody = action === "delete_volume"
    ? { typed_resource_id: typedResource }
    : action === "purge_environment"
      ? { typed_resource_name: typedResource }
      : undefined;
  await post(
    `/api/confirmations/item/${encodeURIComponent(confirmation.user_code)}/confirm`,
    typedBody,
  );
  return confirmation.confirm_code;
}

/** Execute one allowlisted OCD command. This is intentionally not a raw argv
 * endpoint: command IDs and typed values are validated against the shared
 * catalog on the server before a process is started. */
export async function runCliAction(
  commandId: string,
  values: WebCliValues = {},
  options: {
    confirmed?: boolean;
    confirmationCode?: string;
    signal?: AbortSignal;
    onOutput?: (channel: "stdout" | "stderr", text: string) => void;
    workspace?: CliActionWorkspace;
  } = {},
): Promise<CliActionResult> {
  const token = getToken();
  if (!token) throw new Error("Unauthorized");
  const response = await fetch(`${window.location.origin}/api/cli-actions/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      command_id: commandId,
      values,
      confirmed: options.confirmed === true,
      confirmation_code: options.confirmationCode,
      workspace: options.workspace,
    }),
    signal: options.signal,
  });
  if (response.status === 401) {
    logout();
    window.location.hash = "#/login";
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `CLI action failed (${response.status})`);
  }
  if (!response.body) throw new Error("CLI action returned no output stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let command = "";
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let durationMs = 0;

  const consume = (line: string) => {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error("CLI action returned a malformed event");
    }
    if (event.type === "start" && typeof event.command === "string") command = event.command;
    if ((event.type === "stdout" || event.type === "stderr") && typeof event.data === "string") {
      const channel = event.type;
      if (channel === "stdout") stdout += event.data;
      else stderr += event.data;
      options.onOutput?.(channel, event.data);
    }
    if (event.type === "error") throw new Error(String(event.error || "Failed to run CLI action"));
    if (event.type === "exit") {
      exitCode = Number(event.code);
      durationMs = Number(event.duration_ms || 0);
      if (event.timed_out) throw new Error("CLI action timed out");
      if (event.truncated) throw new Error("CLI action output exceeded the safe limit");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (pending) consume(pending);
  if (exitCode === null) throw new Error("CLI action ended without an exit status");
  if (exitCode !== 0) {
    const message = stderr.trim().split("\n").filter(Boolean).pop() || stdout.trim() || `${command} failed`;
    throw new Error(message.replace(/^Error:\s*/, ""));
  }
  return { command, stdout, stderr, exitCode, durationMs };
}

export async function runConfirmedCliAction(
  commandId: string,
  values: WebCliValues,
  confirmation: {
    action: ConfirmableCliAction;
    resourceType: string;
    resourceId: string | number;
    typedResource?: string;
  },
  options: { signal?: AbortSignal; onOutput?: (channel: "stdout" | "stderr", text: string) => void } = {},
): Promise<CliActionResult> {
  const confirmationCode = await approveCliAction(
    confirmation.action,
    confirmation.resourceType,
    confirmation.resourceId,
    confirmation.typedResource,
  );
  return runCliAction(commandId, values, {
    ...options,
    confirmed: true,
    confirmationCode,
  });
}
