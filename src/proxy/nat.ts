// nftables front-port redirect layer, owned and applied by the proxy itself
// (it runs as root on every host).
//
// Why NAT instead of binding the front ports directly: Traefik holds a wildcard
// 0.0.0.0 listener on :80 (public web entrypoint — permanent), and on Linux a
// specific-IP listen can NEVER coexist with a wildcard listen on the same port
// (SO_REUSEADDR does not apply to LISTEN sockets). So the proxy binds one
// wildcard-free port per VIP (PROXY_LISTEN_PORT) and DNATs each app's
// user-facing front ports to it —
// prerouting for traffic arriving from other hosts/containers, output for
// host-originated connections. All local to the host; nothing here is routed.

import os from "os";
import path from "path";
import { rmSync } from "fs";
import { PROXY_LISTEN_PORT, PROXY_PUBLIC_LISTEN_PORT, type ProxyApp } from "./config.ts";

const TABLE = "ip ocd-proxy";

function dnatRules(apps: ProxyApp[], publicIngressIp: string | null): string[] {
  return [...apps]
    .sort((a, b) => a.vip.localeCompare(b.vip))
    .flatMap((app) => {
      const rules: string[] = [];
      // Internal path: every user-facing front port on the VIP → the internal
      // listen port. Keys on `daddr=vip`, so it fires on every host.
      const ports = [...new Set(app.frontPorts)].filter((p) => p !== PROXY_LISTEN_PORT).sort((a, b) => a - b);
      if (ports.length > 0) {
        rules.push(`ip daddr ${app.vip} tcp dport { ${ports.join(", ")} } dnat to ${app.vip}:${PROXY_LISTEN_PORT}`);
      }
      // Public raw path: the panel's public port → the public listen port on
      // the app's VIP. Keys on `daddr=publicIngressIp` (the fleet-wide panel
      // public IP) so the byte-identical ruleset only intercepts on the panel.
      if (app.publicPort != null && publicIngressIp) {
        const proto = app.publicProtocol === "udp" ? "udp" : "tcp";
        rules.push(
          `ip daddr ${publicIngressIp} ${proto} dport ${app.publicPort} dnat to ${app.vip}:${PROXY_PUBLIC_LISTEN_PORT}`,
        );
      }
      return rules;
    });
}

/**
 * Render the full `nft -f` ruleset for the current app set. Atomic-replace
 * pattern: `add table` (no-op if it exists) then `flush table` inside the same
 * transaction, so re-applying is idempotent and never leaves a window with no
 * rules. Deterministic (apps sorted by vip, ports deduped and sorted) so the
 * caller can string-compare renders and skip no-op applies.
 */
export function renderNatRuleset(apps: ProxyApp[], publicIngressIp: string | null = null): string {
  const rules = dnatRules(apps, publicIngressIp);
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
