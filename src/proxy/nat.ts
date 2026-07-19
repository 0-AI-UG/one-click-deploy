// nftables front-port redirect layer, owned and applied by the proxy itself
// (it runs as root on every host).
//
// Why NAT instead of binding the front ports directly: Traefik holds wildcard
// 0.0.0.0 listeners on :80 (public web entrypoint — permanent) and
// :20000-20199 (legacy), and on Linux a specific-IP listen can NEVER coexist
// with a wildcard listen on the same port (SO_REUSEADDR does not apply to
// LISTEN sockets). So the proxy binds one wildcard-free port per VIP
// (PROXY_LISTEN_PORT) and DNATs each app's user-facing front ports to it —
// prerouting for traffic arriving from other hosts/containers, output for
// host-originated connections. All local to the host; nothing here is routed.

import os from "os";
import path from "path";
import { rmSync } from "fs";
import { PROXY_LISTEN_PORT, type ProxyApp } from "./config.ts";

const TABLE = "ip ocd-proxy";

function dnatRules(apps: ProxyApp[]): string[] {
  return [...apps]
    .sort((a, b) => a.vip.localeCompare(b.vip))
    .flatMap((app) => {
      const ports = [...new Set(app.frontPorts)].filter((p) => p !== PROXY_LISTEN_PORT).sort((a, b) => a - b);
      if (ports.length === 0) return [];
      return [`ip daddr ${app.vip} tcp dport { ${ports.join(", ")} } dnat to ${app.vip}:${PROXY_LISTEN_PORT}`];
    });
}

/**
 * Render the full `nft -f` ruleset for the current app set. Atomic-replace
 * pattern: `add table` (no-op if it exists) then `flush table` inside the same
 * transaction, so re-applying is idempotent and never leaves a window with no
 * rules. Deterministic (apps sorted by vip, ports deduped and sorted) so the
 * caller can string-compare renders and skip no-op applies.
 */
export function renderNatRuleset(apps: ProxyApp[]): string {
  const rules = dnatRules(apps);
  const chain = (name: string, header: string): string =>
    [`  chain ${name} {`, `    ${header}`, ...rules.map((r) => `    ${r}`), `  }`].join("\n");
  return [
    `add table ${TABLE}`,
    `flush table ${TABLE}`,
    `table ${TABLE} {`,
    chain("prerouting", "type nat hook prerouting priority dstnat; policy accept;"),
    chain("output", "type nat hook output priority -100; policy accept;"),
    `}`,
    ``,
  ].join("\n");
}

/** Apply the ruleset via `nft -f <tmpfile>`. nft mmaps its input, so it
 *  refuses pipes ("Not a regular file") — a regular temp file is required.
 *  Throws with nft's stderr on failure. */
export async function applyNatRuleset(ruleset: string): Promise<void> {
  const tmpfile = path.join(os.tmpdir(), `ocd-proxy-nat.${crypto.randomUUID().slice(0, 8)}.nft`);
  await Bun.write(tmpfile, ruleset);
  try {
    const proc = Bun.spawn(["nft", "-f", tmpfile], { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`nft -f exited ${code}: ${stderr.trim()}`);
  } finally {
    rmSync(tmpfile, { force: true });
  }
}
