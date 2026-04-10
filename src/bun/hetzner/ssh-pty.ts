import { unlinkSync } from "fs";
import { buildSshArgs } from "./ssh.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [ssh-pty:${context}]`, ...args);
}

export type PtySession = {
  write: (data: Uint8Array | string) => void;
  kill: () => void;
  exited: Promise<number>;
};

/**
 * Spawn an interactive ssh (or ssh + docker exec) session.
 *
 * Note: this uses `ssh -tt` which asks sshd to allocate a PTY on the remote
 * side. We do NOT allocate a local PTY, so terminal resize events can't be
 * forwarded precisely — we pass initial cols/rows via an exported env var on
 * the remote (`stty cols rows`) before exec. For a richer experience swap in
 * node-pty later.
 */
export function spawnSshPty(opts: {
  ip: string;
  hostKey?: string;
  /** Optional remote command. Omit for an interactive login shell. */
  remoteCommand?: string;
  /** Initial terminal size hint sent via stty before the shell starts. */
  cols?: number;
  rows?: number;
  onStdout: (chunk: Uint8Array) => void;
  onExit: (code: number) => void;
}): PtySession {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 32;

  // Wrap remote command so we size the terminal before exec'ing it.
  let remote: string | undefined;
  if (opts.remoteCommand) {
    remote = `stty cols ${cols} rows ${rows} 2>/dev/null; ${opts.remoteCommand}`;
  } else {
    remote = `stty cols ${cols} rows ${rows} 2>/dev/null; exec $SHELL -l`;
  }

  const { args, tmpKnownHostsPath } = buildSshArgs({
    ip: opts.ip,
    command: remote,
    hostKey: opts.hostKey,
    interactive: true,
  });

  log("spawn", `${opts.ip} cmd=${(opts.remoteCommand || "<shell>").slice(0, 80)}`);

  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Pump stdout
  (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) opts.onStdout(value);
      }
    } catch (err) {
      log("stdout", `error: ${err}`);
    }
  })();

  // Pump stderr onto the same stream
  (async () => {
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) opts.onStdout(value);
      }
    } catch { /* stream closed, process exited */ }
  })();

  const exited = proc.exited.then((code) => {
    log("exit", `${opts.ip} code=${code}`);
    if (tmpKnownHostsPath) { try { unlinkSync(tmpKnownHostsPath); } catch { /* cleanup, file may already be gone */ } }
    opts.onExit(code);
    return code;
  });

  const stdin = proc.stdin as { write(data: string | Uint8Array): void; flush?(): void };

  return {
    write(data) {
      try {
        if (typeof data === "string") stdin.write(data);
        else stdin.write(data);
        stdin.flush?.();
      } catch (err) {
        log("write", `error: ${err}`);
      }
    },
    kill() {
      try { proc.kill(); } catch { /* cleanup, process may already be dead */ }
    },
    exited,
  };
}
