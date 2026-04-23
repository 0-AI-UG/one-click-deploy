import db from "./connection.ts";

export interface DeviceAuthCodeRow {
  device_code: string;
  user_code: string;
  user_id: string | null;
  status: "pending" | "confirmed" | "denied" | "expired";
  expires_at: number;
  created_at: number;
}

function cleanupExpiredCodes(): void {
  db.run(
    "UPDATE device_auth_codes SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
    [Date.now()],
  );
}

export function insertDeviceCode(
  deviceCode: string,
  userCode: string,
  expiresAt: number,
): void {
  cleanupExpiredCodes();
  const now = Date.now();
  db.run(
    "INSERT INTO device_auth_codes (device_code, user_code, user_id, status, expires_at, created_at) VALUES (?, ?, NULL, 'pending', ?, ?)",
    [deviceCode, userCode, expiresAt, now],
  );
}

export function lookupByUserCode(userCode: string): DeviceAuthCodeRow | null {
  return (
    (db
      .query<DeviceAuthCodeRow, [string]>(
        "SELECT * FROM device_auth_codes WHERE user_code = ? LIMIT 1",
      )
      .get(userCode) as DeviceAuthCodeRow | null) ?? null
  );
}

export function confirmDeviceCodeRow(userCode: string, userId: string): boolean {
  const info = db.run(
    "UPDATE device_auth_codes SET status = 'confirmed', user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at >= ?",
    [userId, userCode, Date.now()],
  );
  return info.changes > 0;
}

export function getDeviceCodeRow(deviceCode: string): DeviceAuthCodeRow | null {
  return (
    (db
      .query<DeviceAuthCodeRow, [string]>(
        "SELECT * FROM device_auth_codes WHERE device_code = ? LIMIT 1",
      )
      .get(deviceCode) as DeviceAuthCodeRow | null) ?? null
  );
}

export function deleteDeviceCode(deviceCode: string): void {
  db.run("DELETE FROM device_auth_codes WHERE device_code = ?", [deviceCode]);
}
