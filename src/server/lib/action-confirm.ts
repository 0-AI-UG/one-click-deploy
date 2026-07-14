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
): { action: string; summary: string } | null {
  const row = getByUserCode(userCode);
  if (
    !row ||
    row.user_id !== user.userId ||
    row.status !== "pending" ||
    Date.now() > row.expires_at
  ) {
    return null;
  }
  return { action: row.action, summary: row.summary };
}

export function resolveConfirmation(
  userCode: string,
  user: TokenPayload,
  decision: "confirmed" | "denied",
): boolean {
  return setConfirmationStatusByUserCode(userCode, decision, user.userId);
}

/**
 * Server-side gate for destructive actions. Enforced ONLY for CLI-minted tokens
 * (payload.client === "cli"); UI/browser tokens pass through untouched. For a
 * CLI token, the caller must present the `x-ocd-confirmation` header carrying a
 * confirm_code that was browser-approved for this exact user + action +
 * resource; the code is consumed (single-use) here.
 */
export async function enforceConfirmation(
  request: Request,
  payload: TokenPayload,
  action: string,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  if (payload.client !== "cli") return;

  const token = request.headers.get("x-ocd-confirmation");
  if (!token) {
    throw new ConfirmationError(
      "This action requires browser confirmation. Run it through the ocd CLI so you can approve it in your browser.",
    );
  }

  const ok = consumeConfirmation(token, payload.userId, action, resourceType, resourceId);
  if (!ok) {
    throw new ConfirmationError(
      "Confirmation invalid, expired, or not approved. Re-run the command and approve it in your browser.",
    );
  }
}
