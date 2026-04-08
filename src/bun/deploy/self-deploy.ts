// Self-deploy handoff: when the local bootstrap panel deploys a hosted copy
// of itself, we snapshot the local SQLite DB, re-encrypt the Hetzner token
// with the new JWT_SECRET that will run in the hosted container, clear the
// users table (so the hosted instance's setup wizard creates the real
// admin), and scp the snapshot onto the mounted Hetzner volume before the
// hosted container starts for the first time.
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { unlinkSync, writeFileSync } from "fs";
import path from "path";
import localDb from "../db.ts";
import { DATA_DIR } from "../paths.ts";
import { getJwtSecret } from "../secret-store.ts";
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

  async function step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    try {
      log("snapshot", `→ ${name}`);
      const result = await fn();
      log("snapshot", `✓ ${name}`);
      return result;
    } catch (err) {
      const e = err as Error;
      log("snapshot", `✗ ${name} FAILED: ${e.name}: ${e.message}`);
      if (e.stack) log("snapshot", `stack: ${e.stack.split("\n").slice(0, 5).join(" | ")}`);
      throw err;
    }
  }

  // Dump the live DB to a byte buffer via Bun's Database.serialize(). This
  // sidesteps VACUUM INTO and WAL-racing file copies.
  const bytes = await step("serialize live DB", () => localDb.serialize());
  await step(`write ${bytes.length} bytes to ${snapshotPath}`, () =>
    writeFileSync(snapshotPath, bytes),
  );

  const snap = await step("open snapshot DB", () => new Database(snapshotPath));

  // Re-encrypt every row in encrypted_secrets with the hosted JWT_SECRET.
  const oldKey = await step("derive old encryption key", () => deriveEncryptionKey(getJwtSecret()));
  const newKey = await step("derive new encryption key", () => deriveEncryptionKey(opts.newJwtSecret));

  const rows = await step("read encrypted_secrets rows", () =>
    snap.query("SELECT key, encrypted_value, iv FROM encrypted_secrets").all() as Array<{
      key: string;
      encrypted_value: string;
      iv: string;
    }>,
  );
  log("snapshot", `Found ${rows.length} secret row(s) to re-encrypt`);

  for (const row of rows) {
    const reenc = await step(`re-encrypt secret "${row.key}"`, () =>
      reencryptSecret(row.encrypted_value, row.iv, oldKey, newKey),
    );
    await step(`update snapshot row "${row.key}"`, () =>
      snap.query("UPDATE encrypted_secrets SET encrypted_value = ?, iv = ? WHERE key = ?").run(
        reenc.encrypted,
        reenc.iv,
        row.key,
      ),
    );
  }

  // The snapshot is taken before the build/health-check that flips app
  // status to 'running', so without this the hosted instance would show
  // every app as DEPLOYING forever (it never re-runs the deploy itself).
  // Mark them as running; the hosted reconciler will correct any drift.
  await step("mark apps as running in snapshot", () =>
    snap.query("UPDATE apps SET status = 'running' WHERE status = 'deploying'").run(),
  );

  // The snapshot is also taken before insertDeployment runs, so the
  // hosted instance would show an empty deployment history. Insert a
  // synthetic initial-deploy row for each app so the timeline reflects
  // that the app was deployed at handoff time.
  await step("seed initial deployment_history rows", () =>
    snap
      .query(
        "INSERT INTO deployment_history (app_id, image_tag, git_commit, status, deploy_log, source) " +
          "SELECT id, name || ':latest', 'initial', 'deployed', '', 'self-deploy' FROM apps",
      )
      .run(),
  );

  // Clear user-account state. The hosted instance is NOT in bootstrap mode,
  // so its setup wizard will run on first visit and create the real admin.
  await step("clear users table", () => snap.query("DELETE FROM users").run());

  await step("close snapshot DB", () => snap.close());
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
  const keyPath = getSshKeyPath();
  const pubKeyPath = keyPath + ".pub";

  async function scpTo(localPath: string, remotePath: string) {
    const scpProc = Bun.spawn(
      [
        "scp",
        "-i", keyPath,
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=30",
        localPath,
        `root@${opts.serverIp}:${remotePath}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exit = await scpProc.exited;
    if (exit !== 0) {
      const stderr = await new Response(scpProc.stderr).text();
      throw new Error(`scp ${localPath} failed (exit ${exit}): ${stderr}`);
    }
  }

  try {
    // 1) Upload the DB snapshot to /tmp on the target, then move it into
    //    the mounted volume. The hosted container's DATA_DIR is /app/data,
    //    which is bind-mounted from the host path, so writing
    //    ${hostMountPath}/deploy.db puts the DB exactly where the hosted
    //    Bun server will open it on first boot.
    const ts = Date.now();
    const tmpDb = `/tmp/ocd-handoff-${ts}.sqlite`;
    const tmpKey = `/tmp/ocd-handoff-${ts}-id_ed25519`;
    const tmpPub = `${tmpKey}.pub`;
    log("scp", `Uploading DB snapshot + SSH keypair to ${opts.serverIp}`);
    await scpTo(snapshotPath, tmpDb);

    // 2) Upload the local SSH keypair. The hosted panel needs the same
    //    key to SSH back into the server it's running on (and into any
    //    other existing fleet servers). Without this, every SSH-dependent
    //    action (redeploy, terminal, logs, reconciler) fails on first boot.
    await scpTo(keyPath, tmpKey);
    await scpTo(pubKeyPath, tmpPub);

    // 3) Move everything into the mounted volume with correct ownership
    //    (uid 1000 = the `bun` user inside oven/bun:1-slim) and perms.
    const dbDest = `${opts.hostMountPath}/deploy.db`;
    const sshDir = `${opts.hostMountPath}/ssh`;
    const keyDest = `${sshDir}/id_ed25519`;
    const pubDest = `${sshDir}/id_ed25519.pub`;

    const placeCmd = [
      `mkdir -p ${opts.hostMountPath} ${sshDir}`,
      `mv ${tmpDb} ${dbDest}`,
      `mv ${tmpKey} ${keyDest}`,
      `mv ${tmpPub} ${pubDest}`,
      `chown -R 1000:1000 ${opts.hostMountPath}`,
      `chmod 600 ${dbDest} ${keyDest}`,
      `chmod 644 ${pubDest}`,
      `chmod 700 ${sshDir}`,
    ].join(" && ");

    const mv = await sshExec(opts.serverIp, placeCmd, opts.hostKey);
    if (mv.exitCode !== 0) {
      throw new Error(`Failed to place handoff files on remote volume: ${mv.stderr}`);
    }
    log("done", `Handoff complete: DB + SSH keypair placed under ${opts.hostMountPath}`);
  } finally {
    try { unlinkSync(snapshotPath); } catch {}
  }
}

export function getLocalDbPath(): string {
  return path.join(DATA_DIR, "deploy.db");
}
