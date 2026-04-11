import { unlinkSync } from "fs";
import { buildSshArgs } from "./ssh.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [ssh-pty:${context}]`, ...args);
}

export type PtySession = {
  write: (data: Uint8Array | string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  exited: Promise<number>;
};

/**
 * Spawn an interactive ssh (or ssh + docker exec) session inside a real local
 * pseudo-terminal. Bun allocates the PTY for us (`terminal:` option), so ssh
 * sees a tty on both ends — raw mode, control sequences, SIGWINCH-driven
 * resize, and full-screen TUIs (htop, vim, less) all work correctly.
 *
 * Resizes come in via `resize(cols, rows)` → Bun TIOCSWINSZ on the local PTY
 * master → SIGWINCH to ssh → forwarded through the ssh channel → remote sshd
 * resizes the remote PTY → SIGWINCH to the remote shell.
 */
export function spawnSshPty(opts: {
  ip: string;
  hostKey?: string;
  /** Optional remote command. Omit for an interactive login shell. */
  remoteCommand?: string;
  /** Initial terminal size. */
  cols?: number;
  rows?: number;
  onStdout: (chunk: Uint8Array) => void;
  onExit: (code: number) => void;
}): PtySession {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 32;

  const { args, tmpKnownHostsPath } = buildSshArgs({
    ip: opts.ip,
    command: opts.remoteCommand,
    hostKey: opts.hostKey,
    interactive: true,
  });

  log("spawn", `${opts.ip} cmd=${(opts.remoteCommand || "<shell>").slice(0, 80)}`);

  const proc = Bun.spawn(args, {
    terminal: {
      cols,
      rows,
      data: (_terminal, chunk) => {
        try { opts.onStdout(chunk); } catch (err) { log("data", `error: ${err}`); }
      },
    },
  });

  const terminal = proc.terminal!;

  const exited = proc.exited.then((code) => {
    log("exit", `${opts.ip} code=${code}`);
    if (tmpKnownHostsPath) { try { unlinkSync(tmpKnownHostsPath); } catch { /* cleanup, file may already be gone */ } }
    try { terminal.close(); } catch { /* terminal may already be closed */ }
    opts.onExit(code);
    return code;
  });

  return {
    write(data) {
      try {
        terminal.write(data);
      } catch (err) {
        log("write", `error: ${err}`);
      }
    },
    resize(newCols, newRows) {
      try {
        terminal.resize(newCols, newRows);
      } catch (err) {
        log("resize", `error: ${err}`);
      }
    },
    kill() {
      try { proc.kill(); } catch { /* cleanup, process may already be dead */ }
    },
    exited,
  };
}
