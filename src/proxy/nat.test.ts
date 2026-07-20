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

  test("render depends only on vip and frontPorts — backend/sleeping/name churn keeps the skip-compare stable", () => {
    // main.ts skips `nft -f` when the render is string-identical; backend pool
    // churn and sleeping flips must not defeat that skip.
    const before = renderNatRuleset([app({ backends: [], sleeping: true, name: "web" })]);
    const after = renderNatRuleset([
      app({ backends: ["10.0.0.9:12345", "10.0.0.10:12345"], sleeping: false, name: "renamed" }),
    ]);
    expect(after).toBe(before);
  });

  test("public TCP app: adds a daddr=publicIngressIp rule → the public listen port, alongside the internal rule", () => {
    const out = renderNatRuleset(
      [app({ vip: "10.96.0.14", frontPorts: [80, 3000], publicPort: 30040, publicProtocol: "tcp" })],
      "203.0.113.10",
    );
    // Internal rule keys on the vip; public rule keys on the panel public IP.
    expect(out).toContain("ip daddr 10.96.0.14 tcp dport { 80, 3000 } dnat to 10.96.0.14:18790");
    expect(out).toContain("ip daddr 203.0.113.10 tcp dport 30040 dnat to 10.96.0.14:18789");
  });

  test("public UDP app: emits a udp DNAT rule to the public listen port", () => {
    const out = renderNatRuleset(
      [app({ vip: "10.96.0.20", frontPorts: [5432], publicPort: 30090, publicProtocol: "udp" })],
      "203.0.113.10",
    );
    expect(out).toContain("ip daddr 203.0.113.10 udp dport 30090 dnat to 10.96.0.20:18789");
    // Still one internal TCP rule.
    expect(out).toContain("ip daddr 10.96.0.20 tcp dport { 5432 } dnat to 10.96.0.20:18790");
  });

  test("publicProtocol defaults to tcp when omitted", () => {
    const out = renderNatRuleset([app({ vip: "10.96.0.14", frontPorts: [80], publicPort: 30041 })], "203.0.113.10");
    expect(out).toContain("ip daddr 203.0.113.10 tcp dport 30041 dnat to 10.96.0.14:18789");
  });

  test("no publicIngressIp: public apps emit NO public rule (only the panel has the IP)", () => {
    const withPort = app({ vip: "10.96.0.14", frontPorts: [80], publicPort: 30040, publicProtocol: "tcp" });
    const out = renderNatRuleset([withPort]); // publicIngressIp defaults to null
    expect(out).not.toContain("18789");
    expect(out).not.toContain("30040");
    // The internal rule is unchanged — byte-identical to an app without a public port.
    expect(out).toBe(renderNatRuleset([app({ vip: "10.96.0.14", frontPorts: [80] })]));
  });

  test("internal rules are unchanged by the public-path additions", () => {
    const withPublic = renderNatRuleset(
      [app({ vip: "10.96.0.14", frontPorts: [80, 3000], publicPort: 30040 })],
      null, // no ingress IP → no public rule
    );
    const withoutPublic = renderNatRuleset([app({ vip: "10.96.0.14", frontPorts: [80, 3000] })], null);
    expect(withPublic).toBe(withoutPublic);
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
