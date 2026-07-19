// Config parsing/validation and the poll-based reloader.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, watchConfig, type ProxyConfig } from "./config.ts";

const dir = mkdtempSync(join(tmpdir(), "ocd-proxy-config-"));
let fileNo = 0;

function writeConfig(content: string): string {
  const path = join(dir, `config-${fileNo++}.json`);
  writeFileSync(path, content);
  return path;
}

function validConfig(): ProxyConfig {
  return {
    version: 1,
    wakeUrl: "http://10.0.0.1:8896/wake",
    wakeSecret: "s3cret",
    apps: [
      {
        appId: 5,
        name: "web",
        vip: "10.96.0.5",
        listeners: [
          { port: 80, protocol: "tcp" },
          { port: 20005, protocol: "tcp" },
        ],
        backends: ["10.0.0.3:10004"],
        sleeping: false,
      },
    ],
  };
}

describe("loadConfig", () => {
  test("parses a valid config", async () => {
    const cfg = await loadConfig(writeConfig(JSON.stringify(validConfig())));
    expect(cfg.version).toBe(1);
    expect(cfg.apps).toHaveLength(1);
    expect(cfg.apps[0].vip).toBe("10.96.0.5");
    expect(cfg.apps[0].listeners[1]).toEqual({ port: 20005, protocol: "tcp" });
  });

  test("rejects an unknown version", async () => {
    const path = writeConfig(JSON.stringify({ ...validConfig(), version: 2 }));
    expect(loadConfig(path)).rejects.toThrow(/unknown version/);
  });

  test("rejects non-JSON content", async () => {
    expect(loadConfig(writeConfig("not json {"))).rejects.toThrow(/not valid JSON/);
  });

  test("rejects malformed app entries", async () => {
    const missingVip = validConfig();
    (missingVip.apps[0] as Record<string, unknown>).vip = 42;
    expect(loadConfig(writeConfig(JSON.stringify(missingVip)))).rejects.toThrow(/vip/);

    const badBackend = validConfig();
    badBackend.apps[0].backends = ["no-port"];
    expect(loadConfig(writeConfig(JSON.stringify(badBackend)))).rejects.toThrow(/backend/);

    const badProtocol = validConfig();
    (badProtocol.apps[0].listeners[0] as Record<string, unknown>).protocol = "sctp";
    expect(loadConfig(writeConfig(JSON.stringify(badProtocol)))).rejects.toThrow(/protocol/);

    const badSecret = validConfig();
    (badSecret as Record<string, unknown>).wakeSecret = null;
    expect(loadConfig(writeConfig(JSON.stringify(badSecret)))).rejects.toThrow(/wakeSecret/);
  });
});

describe("watchConfig", () => {
  test("invokes onChange when the file content changes, survives a broken write", async () => {
    const path = writeConfig(JSON.stringify(validConfig()));
    const seen: ProxyConfig[] = [];
    const stop = watchConfig(path, (cfg) => seen.push(cfg), 50);
    try {
      await Bun.sleep(150); // baseline seeded, unchanged content → no callback
      expect(seen).toHaveLength(0);

      writeFileSync(path, "broken {"); // parse error → logged, old config kept
      await Bun.sleep(150);
      expect(seen).toHaveLength(0);

      const next = validConfig();
      next.apps[0].sleeping = true;
      writeFileSync(path, JSON.stringify(next));
      await Bun.sleep(300);
      expect(seen).toHaveLength(1);
      expect(seen[0].apps[0].sleeping).toBe(true);
    } finally {
      stop();
    }
  });
});
