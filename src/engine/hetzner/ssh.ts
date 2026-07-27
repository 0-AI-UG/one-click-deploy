import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { SSH_DIR } from "../../shared/paths.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

const sshDir = SSH_DIR;

export async function getOrCreateLocalKeyPair(): Promise<{ publicKey: string; privateKeyPath: string }> {
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

  type SshKey = { id: number; name: string; public_key: string; fingerprint: string };
  const existing = await hetznerApi(`/ssh_keys?name=${name}`) as unknown as { ssh_keys: SshKey[] };
  if (existing.ssh_keys.length > 0) {
    const remote = existing.ssh_keys[0];
    const remoteFingerprint = remote.public_key?.trim().split(/\s+/).slice(0, 2).join(" ");
    const localFingerprint = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
    if (remoteFingerprint === localFingerprint) {
      log("ssh-key", `Found existing SSH key on Hetzner: id=${remote.id} (matches local)`);
      return { ...remote, privateKeyPath };
    }
    // Local key differs from Hetzner — replace it
    log("ssh-key", `Local key differs from Hetzner key id=${remote.id}, replacing...`);
    await hetznerApi(`/ssh_keys/${remote.id}`, { method: "DELETE" });
    log("ssh-key", `Deleted stale SSH key id=${remote.id}`);
  }

  log("ssh-key", "Uploading SSH key to Hetzner...");
  const data = await hetznerApi("/ssh_keys", {
    method: "POST",
    body: JSON.stringify({ name, public_key: publicKey }),
  }) as unknown as { ssh_key: SshKey };
  log("ssh-key", `SSH key uploaded: id=${data.ssh_key.id}`);
  return { ...data.ssh_key, privateKeyPath };
}

/**
 * Write host key to a temp known_hosts file (caller must unlink on cleanup).
 * Returns the known_hosts path + StrictHostKeyChecking value.
 */
export function writeKnownHostsTmp(ip: string, hostKey?: string): { knownHostsFile: string; strictHostKeyChecking: string; tmpPath: string | null } {
  if (!hostKey) {
    return { knownHostsFile: "/dev/null", strictHostKeyChecking: "no", tmpPath: null };
  }
  const tmpPath = `${tmpdir()}/ocd-known-hosts-${ip.replace(/\./g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmpPath, hostKey);
  return { knownHostsFile: tmpPath, strictHostKeyChecking: "yes", tmpPath };
}

/**
 * Build the ssh CLI args list. If `interactive` is true, use -tt (force PTY)
 * and drop BatchMode. If `command` is undefined, an interactive login shell
 * is opened.
 */
export function buildSshArgs(opts: {
  ip: string;
  command?: string;
  hostKey?: string;
  interactive?: boolean;
  user?: string;
}): { args: string[]; tmpKnownHostsPath: string | null } {
  const keyPath = getSshKeyPath();
  const { knownHostsFile, strictHostKeyChecking, tmpPath } = writeKnownHostsTmp(opts.ip, opts.hostKey);
  const user = opts.user || "root";

  const args: string[] = [
    "ssh",
    "-i", keyPath,
    "-o", `StrictHostKeyChecking=${strictHostKeyChecking}`,
    "-o", `UserKnownHostsFile=${knownHostsFile}`,
    "-o", "ConnectTimeout=10",
  ];
  if (opts.interactive) {
    args.push("-tt");
    // Detect dead connections (no keepalive response for 30s * 3 = 90s)
    // so a hung session exits cleanly instead of silently ignoring input.
    args.push("-o", "ServerAliveInterval=30");
    args.push("-o", "ServerAliveCountMax=3");
  } else {
    args.push("-o", "BatchMode=yes");
  }
  args.push(`${user}@${opts.ip}`);
  if (opts.command !== undefined) args.push(opts.command);
  return { args, tmpKnownHostsPath: tmpPath };
}

/**
 * Build a useful error message from a failed command, appending the last
 * few lines of stderr (or stdout if stderr is empty) so the real cause
 * surfaces instead of a generic "check your config" hint.
 */
export function describeFailure(
  hint: string,
  result: { stdout: string; stderr: string; exitCode: number },
): string {
  const raw = (result.stderr.trim() || result.stdout.trim());
  const detail = raw
    ? raw.split("\n").slice(-3).join(" | ").slice(0, 400)
    : `exit ${result.exitCode}`;
  return `${hint}: ${detail}`;
}

export async function sshExec(
  ip: string,
  command: string,
  hostKey?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const shortCmd = command.length > 120 ? command.slice(0, 120) + "..." : command;
  log("ssh", `Exec on ${ip}: ${shortCmd}`);
  const start = Date.now();

  const { args, tmpKnownHostsPath } = buildSshArgs({ ip, command, hostKey, interactive: false });

  try {
    const proc = Bun.spawn(
      args,
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
      try { unlinkSync(tmpKnownHostsPath); } catch { /* cleanup, file may already be gone */ }
    }
  }
}

/**
 * SSH execution that forwards stdout/stderr incrementally. Long Docker builds
 * use this instead of buffering the whole command until exit, so operation
 * followers see cache/build progress and a heartbeat even during quiet stages.
 */
export async function sshExecStreaming(
  ip: string,
  command: string,
  opts: {
    hostKey?: string;
    onLine?: (line: string, source: "stdout" | "stderr") => void;
    onHeartbeat?: (elapsedMs: number, outputLines: number) => void;
    heartbeatMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const shortCmd = command.length > 120 ? command.slice(0, 120) + "..." : command;
  log("ssh", `Streaming exec on ${ip}: ${shortCmd}`);
  const started = Date.now();
  const { args, tmpKnownHostsPath } = buildSshArgs({
    ip,
    command,
    hostKey: opts.hostKey,
    interactive: false,
  });
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  let outputLines = 0;
  const MAX_CAPTURE = 1024 * 1024;

  async function consume(
    stream: ReadableStream<Uint8Array>,
    source: "stdout" | "stderr",
  ): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let captured = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (captured.length < MAX_CAPTURE) captured += chunk.slice(0, MAX_CAPTURE - captured.length);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        outputLines++;
        opts.onLine?.(line, source);
      }
    }
    pending += decoder.decode();
    if (pending) {
      outputLines++;
      opts.onLine?.(pending, source);
    }
    return captured;
  }

  const heartbeat = setInterval(
    () => opts.onHeartbeat?.(Date.now() - started, outputLines),
    opts.heartbeatMs ?? 30_000,
  );
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      consume(proc.stdout, "stdout"),
      consume(proc.stderr, "stderr"),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearInterval(heartbeat);
    if (tmpKnownHostsPath) {
      try { unlinkSync(tmpKnownHostsPath); } catch { /* cleanup */ }
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
      const ps = await sshExec(ip, "ps -eo comm= | grep -E 'apt|dpkg|curl|docker|traefik|cloud-init' | head -1");
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
  } catch { /* best-effort diagnostics — SSH may not be available yet */ }
  throw new Error("Server provisioning timed out — cloud-init may still be running. Check server logs and try again.");
}
