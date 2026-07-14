import { describe, test, expect } from "bun:test";
import { SERVICE_CATALOG, getCatalogEntry } from "./catalog.ts";

describe("service catalog extraCaps", () => {
  // Official images whose entrypoint runs as root then gosu/su-exec down to a
  // service user need CHOWN/SETUID/SETGID back after the platform's
  // --cap-drop=ALL, or they can't chown their data dir + drop privileges and
  // fail to cold-start on a fresh (root-owned) volume.
  const ROOT_THEN_DROP = ["postgresql", "mysql", "mariadb", "mongodb", "redis", "rabbitmq", "clickhouse"];

  for (const type of ROOT_THEN_DROP) {
    test(`${type} grants CHOWN/SETUID/SETGID`, () => {
      const def = getCatalogEntry(type);
      expect(def, `catalog entry "${type}" missing`).toBeTruthy();
      expect(def!.extraCaps).toEqual(["CHOWN", "SETUID", "SETGID"]);
    });
  }

  test("extraCaps, when present, is a subset of the allowed capability set", () => {
    // Guard against a typo silently widening the hardening surface.
    const ALLOWED = new Set(["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"]);
    for (const def of Object.values(SERVICE_CATALOG)) {
      for (const cap of def.extraCaps ?? []) {
        expect(ALLOWED.has(cap), `${def.type} declares unexpected cap ${cap}`).toBe(true);
      }
    }
  });
});
