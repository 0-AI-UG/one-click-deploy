// Self-deploy handoff: when the local bootstrap panel deploys a hosted copy
// of itself, we snapshot the local SQLite DB, re-encrypt the Hetzner token
// with the new JWT_SECRET that will run in the hosted container, clear the
// users table (so the hosted instance's setup wizard creates the real
// admin), and scp the snapshot onto the mounted Hetzner volume before the
// hosted container starts for the first time.
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { unlinkSync } from "fs";
import path from "path";
import localDb from "../db.ts";
import { DATA_DIR } from "../paths.ts";
import { sshExec } from "../hetzner/ssh.ts";
import { getSshKeyPath } from "../hetzner/ssh.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [self-deploy:${context}]`, ...args);
}

async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
  const rawKey = new TextEncoder().encode(secret);
  const keyMaterial = await crypto.subtle.importKey("raw", rawKey, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("ocd-secrets"),
      info: new TextEncoder().encode("encryption"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function reencryptSecret(
  encryptedB64: string,
  ivB64: string,
  oldKey: CryptoKey,
  newKey: CryptoKey,
): Promise<{ encrypted: string; iv: string }> {
  const oldIv = Buffer.from(ivB64, "base64");
  const oldCipher = Buffer.from(encryptedB64, "base64");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: oldIv }, oldKey, oldCipher);
  const newIv = crypto.getRandomValues(new Uint8Array(12));
  const newCipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: newIv }, newKey, plaintext);
  return {
    encrypted: Buffer.from(newCipher).toString("base64"),
    iv: Buffer.from(newIv).toString("base64"),
  };
}

/**
 * Build a sanitized snapshot of the local SQLite DB: re-encrypt all stored
 * secrets with the hosted instance's JWT_SECRET and clear all user-account
 * tables (the hosted instance's setup wizard will create the real admin).
 */
async function buildSnapshot(opts: { newJwtSecret: string }): Promise<string> {
  const snapshotPath = path.join(tmpdir(), `ocd-handoff-${Date.now()}.sqlite`);
  try { unlinkSync(snapshotPath); } catch {}

  log("snapshot", `Creating VACUUM INTO snapshot at ${snapshotPath}`);
  localDb.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);

  const snap = new Database(snapshotPath);

  // Re-encrypt every row in encrypted_secrets with the hosted JWT_SECRET.
  const oldSecret = process.env.JWT_SECRET || "one-click-deploy-dev-secret";
  const oldKey = await deriveEncryptionKey(oldSecret);
  const newKey = await deriveEncryptionKey(opts.newJwtSecret);

  const rows = snap.query("SELECT key, encrypted_value, iv FROM encrypted_secrets").all() as Array<{
    key: string;
    encrypted_value: string;
    iv: string;
  }>;
  for (const row of rows) {
    const reenc = await reencryptSecret(row.encrypted_value, row.iv, oldKey, newKey);
    snap.query("UPDATE encrypted_secrets SET encrypted_value = ?, iv = ? WHERE key = ?").run(
      reenc.encrypted,
      reenc.iv,
      row.key,
    );
  }
  log("snapshot", `Re-encrypted ${rows.length} secret(s) with new JWT_SECRET`);

  // Clear user-account state. The hosted instance is NOT in bootstrap mode,
  // so its setup wizard will run on first visit and create the real admin.
  // Cascade clears TOTP backup codes and per-user permissions.
  snap.query("DELETE FROM users").run();
  log("snapshot", "Cleared users table — hosted setup wizard will create admin");

  snap.close();
  return snapshotPath;
}

export async function performSelfDeployHandoff(opts: {
  serverIp: string;
  hostKey?: string;
  hostMountPath: string; // host path where the volume is mounted (e.g. /mnt/ocd-ocd-panel-data)
  newJwtSecret: string;
}): Promise<void> {
  log("start", `Handoff to ${opts.serverIp}:${opts.hostMountPath}`);

  const snapshotPath = await buildSnapshot({ newJwtSecret: opts.newJwtSecret });

  try {
    // scp the snapshot to the host volume mount. The hosted container's
    // DATA_DIR is /app/data, which is bind-mounted from the host path, so
    // writing ${hostMountPath}/deploy.db puts the DB exactly where the
    // hosted Bun server will open it on first boot.
    const keyPath = getSshKeyPath();
    const tmpRemote = `/tmp/ocd-handoff-${Date.now()}.sqlite`;
    log("scp", `Uploading snapshot to ${opts.serverIp}:${tmpRemote}`);
    const scpProc = Bun.spawn(
      [
        "scp",
        "-i", keyPath,
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=30",
        snapshotPath,
        `root@${opts.serverIp}:${tmpRemote}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const scpExit = await scpProc.exited;
    if (scpExit !== 0) {
      const stderr = await new Response(scpProc.stderr).text();
      throw new Error(`scp failed (exit ${scpExit}): ${stderr}`);
    }

    // Move into place on the mounted volume and chown to uid 1000 (the
    // default `bun` user inside oven/bun:1-slim).
    const destPath = `${opts.hostMountPath}/deploy.db`;
    const mv = await sshExec(
      opts.serverIp,
      `mkdir -p ${opts.hostMountPath} && mv ${tmpRemote} ${destPath} && chown 1000:1000 ${destPath} && chmod 600 ${destPath}`,
      opts.hostKey,
    );
    if (mv.exitCode !== 0) {
      throw new Error(`Failed to place handoff DB on remote volume: ${mv.stderr}`);
    }
    log("done", `Handoff DB placed at ${destPath}`);
  } finally {
    try { unlinkSync(snapshotPath); } catch {}
  }
}

export function getLocalDbPath(): string {
  return path.join(DATA_DIR, "deploy.db");
}
