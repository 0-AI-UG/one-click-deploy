import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import { BASE_FIREWALL_RULES, reconcileFirewallRules, type FirewallRule } from "./servers.ts";

const ANY = ["0.0.0.0/0", "::/0"];

/** The pre-public-pool rule set every live fleet firewall carries. */
const LEGACY_RULES: FirewallRule[] = [
  { direction: "in", protocol: "tcp", port: "22", source_ips: ANY, description: "SSH" },
  { direction: "in", protocol: "tcp", port: "80", source_ips: ANY, description: "HTTP" },
  { direction: "in", protocol: "tcp", port: "443", source_ips: ANY, description: "HTTPS" },
  { direction: "in", protocol: "icmp", source_ips: ANY, description: "ICMP ping" },
];

describe("reconcileFirewallRules", () => {
  test("base rules include the public raw TCP/UDP pool blocks", () => {
    expect(BASE_FIREWALL_RULES).toContainEqual(
      expect.objectContaining({ direction: "in", protocol: "tcp", port: "30000-30049" }),
    );
    expect(BASE_FIREWALL_RULES).toContainEqual(
      expect.objectContaining({ direction: "in", protocol: "udp", port: "30050-30099" }),
    );
  });

  test("an existing fleet firewall (22/80/443/icmp only) converges to the new rule set", () => {
    const desired = reconcileFirewallRules(LEGACY_RULES);
    expect(desired).not.toBeNull();
    expect(desired).toEqual(BASE_FIREWALL_RULES);
  });

  test("already-converged rules return null (no set_rules API call)", () => {
    expect(reconcileFirewallRules(BASE_FIREWALL_RULES)).toBeNull();
    // Order and extra fields don't matter — only direction/protocol/port.
    expect(reconcileFirewallRules([...BASE_FIREWALL_RULES].reverse())).toBeNull();
  });

  test("operator-added extra rules survive convergence", () => {
    const extra: FirewallRule = {
      direction: "in",
      protocol: "tcp",
      port: "5432",
      source_ips: ["203.0.113.0/24"],
      description: "operator: postgres",
    };
    const desired = reconcileFirewallRules([...LEGACY_RULES, extra]);
    expect(desired).toEqual([...BASE_FIREWALL_RULES, extra]);
  });

  test("a wiped rule set is fully re-asserted", () => {
    expect(reconcileFirewallRules([])).toEqual(BASE_FIREWALL_RULES);
  });
});
