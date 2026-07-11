import readline from "node:readline/promises";

export async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Prompt without echoing the input (for secrets). */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    // Raw mode (echo off) must be on before the prompt appears, so input
    // typed the instant it renders is never echoed.
    stdin.setRawMode?.(true);
    stdin.resume();
    process.stdout.write(question);
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf-8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C
          stdin.setRawMode?.(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}
