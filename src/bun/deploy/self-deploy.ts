// Bootstrap → hosted handoff.
//
// The local bootstrap panel (run in a temporary Docker container via the
// one-liner installer) and the hosted panel share the same JWT_SECRET
// (auto-deploy.ts sets process.env.JWT_SECRET before any secretStore
// operations), so the bootstrap DB can be shipped verbatim to the hosted
// volume without re-encrypting anything. All we do here:
//
//   1. Serialize the live bootstrap DB to a byte buffer.
//   2. Clear the users table in the snapshot (the hosted instance's setup
//      wizard will create the real admin on first visit).
//   3. scp the snapshot + the SSH keypair onto the mounted Hetzner volume.
//
// No secret re-encryption, no synthetic history seeding, no app-status
// fixups — the panel table makes all of that unnecessary.
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { unlinkSync, writeFileSync } from "fs";
import path from "path";
import localDb from "../db.ts";
import { sshExec, getSshKeyPath } from "../hetzner/ssh.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [handoff:${context}]`, ...args);
}

async function buildSnapshot(): Promise<string> {
  const snapshotPath = path.join(tmpdir(), `ocd-handoff-${Date.now()}.sqlite`);
  try { unlinkSync(snapshotPath); } catch {}

  log("snapshot", "Serializing live DB...");
  const bytes = localDb.serialize();
  writeFileSync(snapshotPath, bytes);
  log("snapshot", `Wrote ${bytes.length} bytes to ${snapshotPath}`);

  const snap = new Database(snapshotPath);
  try {
    // The hosted instance is NOT in bootstrap mode, so its setup wizard
    // will prompt for an admin account on first visit.
    snap.query("DELETE FROM users").run();
  } finally {
    snap.close();
  }
  return snapshotPath;
}

/**
 * Place the bootstrap DB snapshot + SSH keypair onto the hosted instance's
 * mounted volume. The hosted container's DATA_DIR (/app/data) is
 * bind-mounted from `hostMountPath`, so writing `${hostMountPath}/deploy.db`
 * makes the hosted server open exactly that DB on first boot.
 */
export async function handoffDbToVolume(opts: {
  serverIp: string;
  hostKey?: string;
  hostMountPath: string;
}): Promise<void> {
  log("start", `Handoff to ${opts.serverIp}:${opts.hostMountPath}`);

  const snapshotPath = await buildSnapshot();
  const keyPath = getSshKeyPath();
  const pubKeyPath = keyPath + ".pub";

  async function scpTo(localPath: string, remotePath: string) {
    const proc = Bun.spawn(
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
    const exit = await proc.exited;
    if (exit !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`scp ${localPath} failed (exit ${exit}): ${stderr}`);
    }
  }

  try {
    const ts = Date.now();
    const tmpDb = `/tmp/ocd-handoff-${ts}.sqlite`;
    const tmpKey = `/tmp/ocd-handoff-${ts}-id_ed25519`;
    const tmpPub = `${tmpKey}.pub`;

    log("scp", "Uploading DB snapshot + SSH keypair...");
    await scpTo(snapshotPath, tmpDb);
    await scpTo(keyPath, tmpKey);
    await scpTo(pubKeyPath, tmpPub);

    // Place files under the mounted volume with uid=1000 (bun user in the
    // oven/bun image). 700 for ssh dir, 600 for private key + DB.
    const dbDest = `${opts.hostMountPath}/deploy.db`;
    const sshDir = `${opts.hostMountPath}/ssh`;
    const keyDest = `${sshDir}/id_ed25519`;
    const pubDest = `${sshDir}/id_ed25519.pub`;

    const cmd = [
      `mkdir -p ${opts.hostMountPath} ${sshDir}`,
      `mv ${tmpDb} ${dbDest}`,
      `mv ${tmpKey} ${keyDest}`,
      `mv ${tmpPub} ${pubDest}`,
      `chown -R 1000:1000 ${opts.hostMountPath}`,
      `chmod 600 ${dbDest} ${keyDest}`,
      `chmod 644 ${pubDest}`,
      `chmod 700 ${sshDir}`,
    ].join(" && ");

    const res = await sshExec(opts.serverIp, cmd, opts.hostKey);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to place handoff files: ${res.stderr}`);
    }
    log("done", `Handoff complete at ${opts.hostMountPath}`);
  } finally {
    try { unlinkSync(snapshotPath); } catch {}
  }
}
