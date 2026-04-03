import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

const sshDir = path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".one-click-deploy",
  "ssh"
);

async function getOrCreateLocalKeyPair(): Promise<{ publicKey: string; privateKeyPath: string }> {
  mkdirSync(sshDir, { recursive: true });
  const keyPath = path.join(sshDir, "id_ed25519");
  const pubPath = keyPath + ".pub";

  if (!existsSync(keyPath)) {
    log("ssh-key", `Generating new Ed25519 key at ${keyPath}`);
    const proc = Bun.spawn(
      ["ssh-keygen", "-t", "ed25519", "-f", keyPath, "-N", "", "-C", "one-click-deploy"],
      { stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
    log("ssh-key", "Key generated");
  } else {
    log("ssh-key", `Using existing key at ${keyPath}`);
  }

  const publicKey = readFileSync(pubPath, "utf-8").trim();
  return { publicKey, privateKeyPath: keyPath };
}

export function getSshKeyPath(): string {
  return path.join(sshDir, "id_ed25519");
}

export async function ensureSshKey(name: string) {
  const { hetznerApi } = await import("./api.ts");
  log("ssh-key", `Ensuring SSH key "${name}" exists...`);
  const { publicKey, privateKeyPath } = await getOrCreateLocalKeyPair();

  const existing = await hetznerApi(`/ssh_keys?name=${name}`);
  if (existing.ssh_keys.length > 0) {
    log("ssh-key", `Found existing SSH key on Hetzner: id=${existing.ssh_keys[0].id}`);
    return { ...existing.ssh_keys[0], privateKeyPath };
  }

  log("ssh-key", "Uploading SSH key to Hetzner...");
  const data = await hetznerApi("/ssh_keys", {
    method: "POST",
    body: JSON.stringify({ name, public_key: publicKey }),
  });
  log("ssh-key", `SSH key uploaded: id=${data.ssh_key.id}`);
  return { ...data.ssh_key, privateKeyPath };
}

export async function sshExec(
  ip: string,
  command: string,
  hostKey?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const keyPath = getSshKeyPath();
  const shortCmd = command.length > 120 ? command.slice(0, 120) + "..." : command;
  log("ssh", `Exec on ${ip}: ${shortCmd}`);
  const start = Date.now();

  let knownHostsFile = "/dev/null";
  let strictHostKeyChecking = "no";
  let tmpKnownHostsPath: string | null = null;

  if (hostKey) {
    // Write host key to temp file for verification
    tmpKnownHostsPath = `${tmpdir()}/ocd-known-hosts-${ip.replace(/\./g, "-")}-${Date.now()}`;
    writeFileSync(tmpKnownHostsPath, hostKey);
    knownHostsFile = tmpKnownHostsPath;
    strictHostKeyChecking = "yes";
  }

  try {
    const proc = Bun.spawn(
      [
        "ssh",
        "-i", keyPath,
        "-o", `StrictHostKeyChecking=${strictHostKeyChecking}`,
        "-o", `UserKnownHostsFile=${knownHostsFile}`,
        "-o", "ConnectTimeout=10",
        `root@${ip}`,
        command,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const elapsed = Date.now() - start;
    if (exitCode !== 0) {
      log("ssh", `FAILED (exit=${exitCode}) in ${elapsed}ms: ${stderr.trim().slice(0, 200)}`);
    } else {
      log("ssh", `OK in ${elapsed}ms (stdout=${stdout.trim().length} bytes)`);
    }
    return { stdout, stderr, exitCode };
  } finally {
    if (tmpKnownHostsPath) {
      try { unlinkSync(tmpKnownHostsPath); } catch {}
    }
  }
}

export async function captureHostKey(ip: string): Promise<string> {
  log("ssh", `Capturing host key for ${ip}`);
  const proc = Bun.spawn(
    ["ssh-keyscan", "-t", "ed25519", ip],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const hostKey = stdout.trim();
  if (!hostKey) {
    log("ssh", `Warning: no host key captured for ${ip}`);
  } else {
    log("ssh", `Host key captured for ${ip}: ${hostKey.slice(0, 60)}...`);
  }
  return hostKey;
}

export async function waitForServer(
  ip: string,
  maxAttempts = 30,
  onStatus?: (msg: string) => void,
) {
  log("wait", `Polling ${ip} for provisioning (max ${maxAttempts} attempts, 10s interval)...`);
  for (let i = 0; i < maxAttempts; i++) {
    const elapsed = i * 10;
    try {
      log("wait", `Attempt ${i + 1}/${maxAttempts}...`);
      const result = await sshExec(ip, "test -f /root/.provisioned && echo ok");
      if (result.stdout.trim() === "ok") {
        log("wait", `Server ${ip} ready after ${i + 1} attempts`);
        onStatus?.("Server ready");
        return true;
      }
      // SSH works but cloud-init still running — check what's happening
      const ps = await sshExec(ip, "ps -eo comm= | grep -E 'apt|dpkg|curl|docker|caddy|cloud-init' | head -1");
      const running = ps.stdout.trim();
      const detail = running ? `installing ${running}` : "finishing setup";
      log("wait", `Not ready yet — ${detail}`);
      onStatus?.(`Provisioning... ${detail} (${elapsed}s)`);
    } catch (err) {
      log("wait", `Attempt ${i + 1} error: ${err instanceof Error ? err.message : err}`);
      onStatus?.(`Waiting for SSH... (${elapsed}s)`);
    }
    await Bun.sleep(10_000);
  }
  // Grab diagnostics before throwing
  try {
    const diag = await sshExec(ip, "cat /var/log/cloud-init-deploy.log | tail -30 2>/dev/null; echo '---'; cloud-init status 2>/dev/null");
    log("wait", `Timeout diagnostics:\n${diag.stdout}\n${diag.stderr}`);
  } catch {}
  throw new Error("Server provisioning timed out — cloud-init may still be running. Check server logs and try again.");
}
