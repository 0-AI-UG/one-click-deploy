// ocd-proxy provisioning — path constants, the systemd unit, and the install
// script the manager runs after scp-ing a freshly built binary to a server.
// Mirrors traefik-provision.ts; proxy-render.ts owns the config content and
// proxy-manager.ts owns delivery/convergence.

import { VIP_RANGE } from "../../shared/db/apps.ts";

export const PROXY_BIN_PATH = "/usr/local/bin/ocd-proxy";
export const PROXY_CONFIG_DIR = "/etc/ocd-proxy";
export const PROXY_CONFIG_PATH = `${PROXY_CONFIG_DIR}/config.json`;
export const PROXY_UNIT_PATH = "/etc/systemd/system/ocd-proxy.service";

/**
 * systemd unit for the host-level VIP proxy. The ExecStartPre local-route
 * insert is what makes the whole 10.96.0.0/16 block terminate on this host
 * (idempotent `ip route replace`), and living inside the unit ties VIP
 * routability to the proxy actually being up. Restart=always — once
 * /etc/hosts points apps at VIPs, this proxy is the server's only path to
 * them.
 */
export function proxySystemdUnit(): string {
  return `[Unit]
Description=OCD virtual-IP proxy
After=network-online.target
Wants=network-online.target

[Service]
ExecStartPre=/usr/sbin/ip route replace local ${VIP_RANGE} dev lo
ExecStart=${PROXY_BIN_PATH} --config ${PROXY_CONFIG_PATH}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Install/upgrade script run over SSH after the compiled binary has been
 * scp-ed to `tmpBinPath`. Unlike Traefik there is no download step — the
 * panel cross-compiles and ships the binary itself. Verification is layered:
 * the shipped bytes must match the panel-side sha (scp corruption), the
 * installed binary must run and report the expected version (garbage binary —
 * caught BEFORE the restart, so a bad ship can't take down a working proxy),
 * and after the restart a settle delay outlives one Restart=always cycle
 * (RestartSec=2) so `is-active` can't report the few-ms "active" window of a
 * binary that dies on boot.
 */
export function proxyInstallScript(
  tmpBinPath: string,
  expected: { sha256: string; version: string },
): string {
  return `set -e
echo "${expected.sha256}  ${tmpBinPath}" | sha256sum -c - >/dev/null
chmod 755 ${tmpBinPath}
V=$(${tmpBinPath} --version)
[ "$V" = "${expected.version}" ] || { echo "shipped binary reports version $V, want ${expected.version}" >&2; exit 1; }
install -m 755 ${tmpBinPath} ${PROXY_BIN_PATH}
rm -f ${tmpBinPath}
mkdir -p ${PROXY_CONFIG_DIR}
cat > ${PROXY_UNIT_PATH} <<'OCD_PROXY_UNIT'
${proxySystemdUnit()}
OCD_PROXY_UNIT
systemctl daemon-reload
systemctl enable ocd-proxy
systemctl restart ocd-proxy
sleep 3
systemctl is-active ocd-proxy
`;
}
