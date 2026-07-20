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
        frontPorts: [80, 20005],
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
    expect(cfg.apps[0].frontPorts).toEqual([80, 20005]);
    expect(cfg.listenPort).toBeUndefined();
  });

  test("accepts a listenPort override, rejects out-of-range values", async () => {
    const withPort = await loadConfig(writeConfig(JSON.stringify({ ...validConfig(), listenPort: 12345 })));
    expect(withPort.listenPort).toBe(12345);
    const badPort = writeConfig(JSON.stringify({ ...validConfig(), listenPort: 0 }));
    expect(loadConfig(badPort)).rejects.toThrow(/listenPort/);
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

    const emptyPorts = validConfig();
    emptyPorts.apps[0].frontPorts = [];
    expect(loadConfig(writeConfig(JSON.stringify(emptyPorts)))).rejects.toThrow(/frontPorts/);

    const badPort = validConfig();
    badPort.apps[0].frontPorts = [80, 70000];
    expect(loadConfig(writeConfig(JSON.stringify(badPort)))).rejects.toThrow(/frontPorts/);

    const badSecret = validConfig();
    (badSecret as Record<string, unknown>).wakeSecret = null;
    expect(loadConfig(writeConfig(JSON.stringify(badSecret)))).rejects.toThrow(/wakeSecret/);
  });
});

describe("public raw ingress fields", () => {
  test("preserves publicPort/publicProtocol on an app and publicIngressIp on the root", async () => {
    const cfg = validConfig();
    (cfg as Record<string, unknown>).publicIngressIp = "203.0.113.10";
    (cfg.apps[0] as Record<string, unknown>).publicPort = 30040;
    (cfg.apps[0] as Record<string, unknown>).publicProtocol = "udp";
    const parsed = await loadConfig(writeConfig(JSON.stringify(cfg)));
    expect(parsed.publicIngressIp).toBe("203.0.113.10");
    expect(parsed.apps[0].publicPort).toBe(30040);
    expect(parsed.apps[0].publicProtocol).toBe("udp");
  });

  test("publicIngressIp may be null; omitted fields stay absent", async () => {
    const cfg = validConfig();
    (cfg as Record<string, unknown>).publicIngressIp = null;
    const parsed = await loadConfig(writeConfig(JSON.stringify(cfg)));
    expect(parsed.publicIngressIp).toBeNull();
    expect(parsed.apps[0].publicPort).toBeUndefined();
    expect(parsed.apps[0].publicProtocol).toBeUndefined();
  });

  test("rejects an out-of-range publicPort and a bad publicProtocol", async () => {
    const badPort = validConfig();
    (badPort.apps[0] as Record<string, unknown>).publicPort = 70000;
    expect(loadConfig(writeConfig(JSON.stringify(badPort)))).rejects.toThrow(/publicPort/);

    const badProto = validConfig();
    (badProto.apps[0] as Record<string, unknown>).publicProtocol = "sctp";
    expect(loadConfig(writeConfig(JSON.stringify(badProto)))).rejects.toThrow(/publicProtocol/);

    const badIp = validConfig();
    (badIp as Record<string, unknown>).publicIngressIp = 42;
    expect(loadConfig(writeConfig(JSON.stringify(badIp)))).rejects.toThrow(/publicIngressIp/);
  });

  test("accepts a publicListenPort override, rejects out-of-range values", async () => {
    const ok = await loadConfig(writeConfig(JSON.stringify({ ...validConfig(), publicListenPort: 12345 })));
    expect(ok.publicListenPort).toBe(12345);
    expect(loadConfig(writeConfig(JSON.stringify({ ...validConfig(), publicListenPort: 0 })))).rejects.toThrow(
      /publicListenPort/,
    );
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

  test("rewriting identical content (touch) does not fire onChange", async () => {
    const content = JSON.stringify(validConfig());
    const path = writeConfig(content);
    const seen: ProxyConfig[] = [];
    const stop = watchConfig(path, (cfg) => seen.push(cfg), 50);
    try {
      await Bun.sleep(150); // baseline seeded
      writeFileSync(path, content); // mtime changes, content identical
      await Bun.sleep(200);
      expect(seen).toHaveLength(0);
    } finally {
      stop();
    }
  });
});

describe("contract: authProtected app flag (P1b)", () => {
  // REGRESSION: currently failing by design
  test("loadConfig preserves authProtected on the app entry", async () => {
    const cfg = validConfig();
    (cfg.apps[0] as Record<string, unknown>).authProtected = true;
    const parsed = await loadConfig(writeConfig(JSON.stringify(cfg)));
    expect((parsed.apps[0] as { authProtected?: boolean }).authProtected).toBe(true);
  });
});

describe("contract: watch baseline seeded from the initially loaded text (P6)", () => {
  // REGRESSION: currently failing by design
  test("a config write landing between initial load and the first poll fires onChange", async () => {
    const initialText = JSON.stringify(validConfig());
    const path = writeConfig(initialText);
    await loadConfig(path); // startup load — the watch baseline must be THIS text
    // The write lands after the initial load but before the watch starts —
    // exactly the window where a baseline seeded by re-reading the file
    // absorbs the change and silently never fires onChange.
    const next = validConfig();
    next.apps[0].sleeping = true;
    writeFileSync(path, JSON.stringify(next));
    const seen: ProxyConfig[] = [];
    // Contract seam: optional 4th arg `initialText` seeds the change-detection
    // baseline synchronously from the text loadConfig read, instead of
    // re-reading the file (which can absorb a racing write into the baseline).
    const watch = watchConfig as unknown as (
      path: string,
      onChange: (cfg: ProxyConfig) => void,
      intervalMs?: number,
      initialText?: string,
    ) => () => void;
    const stop = watch(path, (cfg) => seen.push(cfg), 50, initialText);
    try {
      await Bun.sleep(400);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0].apps[0].sleeping).toBe(true);
    } finally {
      stop();
    }
  });
});
