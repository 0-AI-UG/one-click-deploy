import { type TokenPayload } from "./auth.ts";
import { ConfirmationError } from "./errors.ts";
import {
  insertConfirmation,
  getByConfirmCode,
  getByUserCode,
  setConfirmationStatusByUserCode,
  deleteConfirmation,
  consumeConfirmation,
} from "../../shared/db/action-confirmations.ts";

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 to avoid confusion
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code.slice(0, 4) + "-" + code.slice(4);
}

const CONFIRMATION_TTL = 10 * 60 * 1000; // 10 minutes

export function createConfirmation(
  user: TokenPayload,
  action: string,
  resourceType: string,
  resourceId: string,
  summary: string,
): { confirmCode: string; userCode: string; expiresIn: number } {
  const confirmCode = crypto.randomUUID();
  const userCode = generateCode();
  const expiresAt = Date.now() + CONFIRMATION_TTL;

  insertConfirmation(confirmCode, userCode, user.userId, action, summary, resourceType, resourceId, expiresAt);

  return { confirmCode, userCode, expiresIn: Math.floor(CONFIRMATION_TTL / 1000) };
}

export function pollConfirmation(
  confirmCode: string,
): { status: "pending" | "confirmed" | "denied" | "expired" } {
  const row = getByConfirmCode(confirmCode);

  if (!row) return { status: "expired" };

  if (row.status === "expired" || Date.now() > row.expires_at) {
    deleteConfirmation(confirmCode);
    return { status: "expired" };
  }

  // On 'confirmed' we deliberately keep the row: the CLI must still consume it
  // at delete time (enforceConfirmation → consumeConfirmation deletes it then).
  if (row.status === "confirmed") {
    return { status: "confirmed" };
  }

  if (row.status === "denied") {
    deleteConfirmation(confirmCode);
    return { status: "denied" };
  }

  return { status: "pending" };
}

export function getPendingForUser(
  userCode: string,
  user: TokenPayload,
): { action: string; summary: string; resourceType: string; resourceId: string } | null {
  const row = getByUserCode(userCode);
  if (
    !row ||
    row.user_id !== user.userId ||
    row.status !== "pending" ||
    Date.now() > row.expires_at
  ) {
    return null;
  }
  return {
    action: row.action,
    summary: row.summary,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
  };
}

export function resolveConfirmation(
  userCode: string,
  user: TokenPayload,
  decision: "confirmed" | "denied",
): boolean {
  return setConfirmationStatusByUserCode(userCode, decision, user.userId);
}

/**
 * Server-side gate for destructive actions. Stack/environment/volume deletion
 * always requires a server-issued, browser-approved confirmation, including
 * requests made with a web token. Other actions retain the historical
 * CLI-only gate. The code is bound to the exact user/action/resource and is
 * consumed here exactly once.
 */
export async function enforceConfirmation(
  request: Request,
  payload: TokenPayload,
  action: string,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  const alwaysBrowserConfirmed =
    action === "delete_environment" ||
    action === "purge_environment" ||
    action === "delete_stack" ||
    action === "delete_volume";
  if (payload.client !== "cli" && !alwaysBrowserConfirmed) return;

  const token = request.headers.get("x-ocd-confirmation");
  if (!token) {
    throw new ConfirmationError(
      payload.client === "cli"
        ? "This action requires browser confirmation. Re-run it through the ocd CLI and approve it in your browser."
        : "This action requires a server-issued browser confirmation. Use the OCD web UI to perform it.",
    );
  }

  // Non-interactive automation is opt-in at the command line (`--yes`) and is
  // still authenticated by the signed CLI bearer token + normal destructive
  // permission. Bind the approval to the exact action and resource so it cannot
  // be replayed for a broader target.
  const automationApproval = `automation:${action}:${resourceType}:${resourceId}`;
  if (token === automationApproval) {
    // Environments are durable user-owned configuration, independent of any
    // app/stack lifecycle. Stack deletion fans out across several resources.
    // These therefore always require human approval in the browser; do not
    // let an old CLI's --yes token bypass that invariant. Permanent provider
    // volume deletion is included because it irreversibly destroys user data.
    if (
      action === "delete_environment" ||
      action === "purge_environment" ||
      action === "delete_stack" ||
      action === "delete_volume"
    ) {
      throw new ConfirmationError(
        "This action always requires confirmation in the OCD web UI. Re-run the command and approve it in your browser.",
      );
    }
    return;
  }

  const ok = consumeConfirmation(token, payload.userId, action, resourceType, resourceId);
  if (!ok) {
    throw new ConfirmationError(
      "Confirmation invalid, expired, or not approved. Re-run the command and approve it in your browser.",
    );
  }
}
