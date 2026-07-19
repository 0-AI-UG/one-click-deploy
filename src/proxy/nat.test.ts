// Rendered nft ruleset: golden shape, dedup, PROXY_LISTEN_PORT exclusion,
// deterministic ordering. applyNatRuleset is not exercised against a real nft
// (root-only, and the binary is absent on macOS dev machines).
import { describe, test, expect } from "bun:test";
import { PROXY_LISTEN_PORT, type ProxyApp } from "./config.ts";
import { renderNatRuleset } from "./nat.ts";

function app(over: Partial<ProxyApp>): ProxyApp {
  return {
    appId: 1,
    name: "web",
    vip: "10.96.0.14",
    frontPorts: [80],
    backends: [],
    sleeping: false,
    ...over,
  };
}

describe("renderNatRuleset", () => {
  test("multi-app ruleset: atomic replace preamble, one dnat rule per app in both chains", () => {
    const apps = [
      app({ appId: 1, vip: "10.96.0.14", frontPorts: [80, 3000, 20013] }),
      app({ appId: 2, vip: "10.96.0.20", frontPorts: [5432, 20020] }),
    ];
    expect(renderNatRuleset(apps)).toBe(
      [
        "add table ip ocd-proxy",
        "flush table ip ocd-proxy",
        "table ip ocd-proxy {",
        "  chain prerouting {",
        "    type nat hook prerouting priority dstnat; policy accept;",
        "    ip daddr 10.96.0.14 tcp dport { 80, 3000, 20013 } dnat to 10.96.0.14:18790",
        "    ip daddr 10.96.0.20 tcp dport { 5432, 20020 } dnat to 10.96.0.20:18790",
        "  }",
        "  chain output {",
        "    type nat hook output priority -100; policy accept;",
        "    ip daddr 10.96.0.14 tcp dport { 80, 3000, 20013 } dnat to 10.96.0.14:18790",
        "    ip daddr 10.96.0.20 tcp dport { 5432, 20020 } dnat to 10.96.0.20:18790",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("front ports are deduped and sorted within a rule", () => {
    const out = renderNatRuleset([app({ frontPorts: [3000, 80, 3000, 80] })]);
    expect(out).toContain("tcp dport { 80, 3000 } dnat");
    expect(out).not.toContain("3000, 80");
  });

  test("PROXY_LISTEN_PORT is excluded; an app with only that port renders no rule", () => {
    const out = renderNatRuleset([app({ frontPorts: [80, PROXY_LISTEN_PORT] })]);
    expect(out).toContain("tcp dport { 80 } dnat");
    expect(out).not.toContain(`dport { 80, ${PROXY_LISTEN_PORT} }`);

    const only = renderNatRuleset([app({ frontPorts: [PROXY_LISTEN_PORT] })]);
    expect(only).not.toContain("dnat");
  });

  test("deterministic: apps sorted by vip regardless of input order", () => {
    const a = app({ appId: 1, vip: "10.96.0.2", frontPorts: [80] });
    const b = app({ appId: 2, vip: "10.96.0.10", frontPorts: [80] });
    expect(renderNatRuleset([b, a])).toBe(renderNatRuleset([a, b]));
    const out = renderNatRuleset([b, a]);
    expect(out.indexOf("10.96.0.10")).toBeLessThan(out.indexOf("10.96.0.2"));
  });

  test("empty apps: still a valid table with empty chains (clears stale rules)", () => {
    expect(renderNatRuleset([])).toBe(
      [
        "add table ip ocd-proxy",
        "flush table ip ocd-proxy",
        "table ip ocd-proxy {",
        "  chain prerouting {",
        "    type nat hook prerouting priority dstnat; policy accept;",
        "  }",
        "  chain output {",
        "    type nat hook output priority -100; policy accept;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });
});
