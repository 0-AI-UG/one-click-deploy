import { createToken, type TokenPayload } from "./auth.ts";
import {
  insertDeviceCode,
  lookupByUserCode,
  confirmDeviceCodeRow,
  getDeviceCodeRow,
  deleteDeviceCode,
} from "../../shared/db/device-auth-codes.ts";

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 to avoid confusion
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code.slice(0, 4) + "-" + code.slice(4);
}

const DEVICE_CODE_TTL = 10 * 60 * 1000; // 10 minutes

export function createDeviceCode(): { deviceCode: string; userCode: string; expiresIn: number } {
  const deviceCode = crypto.randomUUID();
  const userCode = generateCode();
  const expiresAt = Date.now() + DEVICE_CODE_TTL;

  insertDeviceCode(deviceCode, userCode, expiresAt);

  return { deviceCode, userCode, expiresIn: Math.floor(DEVICE_CODE_TTL / 1000) };
}

/** Normalise a user-entered code to the canonical "XXXX-XXXX" form stored in DB. */
function normalizeUserCode(raw: string): string {
  const stripped = raw.toUpperCase().replace(/\s+/g, "").replace(/-/g, "");
  if (stripped.length === 8) return stripped.slice(0, 4) + "-" + stripped.slice(4);
  return raw.toUpperCase(); // return as-is if unexpected length; lookup will fail
}

// Ephemeral cache: confirmed tokens awaiting first poll. Keyed by user_code.
// Consumed on first successful poll. A restart between confirm and poll causes
// the device to re-poll and eventually time out — acceptable per plan.
const confirmedTokens = new Map<string, string>();

export async function confirmDeviceCode(
  userCode: string,
  user: TokenPayload,
): Promise<{ ok: boolean; error?: string }> {
  const canonical = normalizeUserCode(userCode);

  const row = lookupByUserCode(canonical);
  if (!row || row.status !== "pending" || Date.now() > row.expires_at) {
    return { ok: false, error: "Invalid or expired code" };
  }

  const ok = confirmDeviceCodeRow(canonical, user.userId);
  if (!ok) return { ok: false, error: "Invalid or expired code" };

  const token = await createToken(user);
  confirmedTokens.set(canonical, token);
  return { ok: true };
}

export function pollDeviceToken(
  deviceCode: string,
): { status: "pending" | "complete" | "expired" | "denied"; token?: string } {
  const row = getDeviceCodeRow(deviceCode);

  if (!row) return { status: "expired" };

  if (row.status === "expired" || Date.now() > row.expires_at) {
    deleteDeviceCode(deviceCode);
    return { status: "expired" };
  }

  if (row.status === "denied") {
    deleteDeviceCode(deviceCode);
    return { status: "denied" };
  }

  if (row.status === "confirmed") {
    const token = confirmedTokens.get(row.user_code);
    confirmedTokens.delete(row.user_code);
    deleteDeviceCode(deviceCode);
    if (!token) {
      // Token was lost (process restart between confirm and poll). Signal
      // expiry so the device re-initiates the flow rather than hanging.
      return { status: "expired" };
    }
    return { status: "complete", token };
  }

  return { status: "pending" };
}
