import { createToken, type TokenPayload } from "./auth.ts";

interface DeviceRequest {
  userCode: string;
  expiresAt: number;
  token: string | null;    // null until user confirms
  denied: boolean;
}

// In-memory store — device codes are short-lived, no persistence needed
const pending = new Map<string, DeviceRequest>();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [code, req] of pending) {
    if (now > req.expiresAt) pending.delete(code);
  }
}, 60_000);

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

  pending.set(deviceCode, {
    userCode,
    expiresAt: Date.now() + DEVICE_CODE_TTL,
    token: null,
    denied: false,
  });

  return { deviceCode, userCode, expiresIn: Math.floor(DEVICE_CODE_TTL / 1000) };
}

export async function confirmDeviceCode(
  userCode: string,
  user: TokenPayload,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = userCode.toUpperCase().replace(/\s+/g, "").replace(/-/g, "");

  for (const [, req] of pending) {
    const reqNormalized = req.userCode.replace(/-/g, "");
    if (reqNormalized === normalized && Date.now() <= req.expiresAt) {
      req.token = await createToken(user);
      return { ok: true };
    }
  }

  return { ok: false, error: "Invalid or expired code" };
}

export function pollDeviceToken(
  deviceCode: string,
): { status: "pending" | "complete" | "expired" | "denied"; token?: string } {
  const req = pending.get(deviceCode);

  if (!req) return { status: "expired" };
  if (Date.now() > req.expiresAt) {
    pending.delete(deviceCode);
    return { status: "expired" };
  }
  if (req.denied) {
    pending.delete(deviceCode);
    return { status: "denied" };
  }
  if (req.token) {
    const token = req.token;
    pending.delete(deviceCode);
    return { status: "complete", token };
  }

  return { status: "pending" };
}
