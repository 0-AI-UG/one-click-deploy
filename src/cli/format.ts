const isTTY = process.stdout.isTTY;

const RESET = isTTY ? "\x1b[0m" : "";
const BOLD = isTTY ? "\x1b[1m" : "";
const DIM = isTTY ? "\x1b[2m" : "";
const GREEN = isTTY ? "\x1b[32m" : "";
const YELLOW = isTTY ? "\x1b[33m" : "";
const RED = isTTY ? "\x1b[31m" : "";
const CYAN = isTTY ? "\x1b[36m" : "";

export function colorStatus(status: string): string {
  switch (status) {
    case "running":
      return `${GREEN}${status}${RESET}`;
    case "deploying":
    case "sleeping":
      return `${YELLOW}${status}${RESET}`;
    case "unhealthy":
    case "error":
      return `${RED}${status}${RESET}`;
    case "paused":
      return `${DIM}${status}${RESET}`;
    default:
      return status;
  }
}

export function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log(DIM + "(none)" + RESET);
    return;
  }

  const widths = headers.map((h, i) => {
    const colValues = rows.map((r) => stripAnsi(r[i] || "").length);
    return Math.max(h.length, ...colValues);
  });

  // Header
  const header = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
  console.log(BOLD + header + RESET);
  console.log(widths.map((w) => "─".repeat(w)).join("  "));

  // Rows
  for (const row of rows) {
    const line = row
      .map((cell, i) => {
        const visible = stripAnsi(cell || "").length;
        const padding = widths[i] - visible;
        return (cell || "") + " ".repeat(Math.max(0, padding));
      })
      .join("  ");
    console.log(line);
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export { BOLD, DIM, GREEN, YELLOW, RED, CYAN, RESET };
