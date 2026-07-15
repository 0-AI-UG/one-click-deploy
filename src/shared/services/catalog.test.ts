import { describe, test, expect } from "bun:test";
import {
  SERVICE_CATALOG,
  generateEnvVars,
  getCatalogEntry,
  resolveEnvVarTemplates,
  resolveServiceImage,
} from "./catalog.ts";

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

describe("Kafka catalog entry", () => {
  test("uses the official image with persistent KRaft storage", () => {
    const def = getCatalogEntry("kafka");
    expect(def).toBeTruthy();
    expect(def!.image).toBe("apache/kafka");
    expect(def!.volumePath).toBe("/var/lib/kafka/data");
    expect(def!.defaultPort).toBe(9092);
    expect(def!.memoryMb).toBeGreaterThanOrEqual(1024);
  });

  test("advertises the allocated stable endpoint while keeping an internal listener", () => {
    const def = getCatalogEntry("kafka")!;
    const env = resolveEnvVarTemplates(generateEnvVars(def), {
      host: "events.svc.ocd.internal",
      port: 10_042,
      internalHost: "events",
      internalPort: 9092,
    });

    expect(env.KAFKA_ADVERTISED_LISTENERS).toBe(
      "INTERNAL://events:19092,EXTERNAL://events.svc.ocd.internal:10042",
    );
    expect(env.KAFKA_LOG_DIRS).toBe(def.volumePath);
  });
});

describe("PostgreSQL extensions", () => {
  test("accepts an optional extension list and provisions it after startup", () => {
    const def = getCatalogEntry("postgresql")!;
    expect(def.requiredEnvVars.some((env) => env.key === "POSTGRES_EXTENSIONS")).toBe(true);
    expect(def.postStartCmd).toContain("CREATE EXTENSION IF NOT EXISTS");
    expect(def.postStartCmd).toContain("ON_ERROR_STOP=1");
    expect(Bun.spawnSync(["sh", "-n", "-c", def.postStartCmd!]).exitCode).toBe(0);
  });

  test("maps extension variants to compatible images and enables their extensions", () => {
    const def = getCatalogEntry("postgresql")!;
    expect(resolveServiceImage(def, "17-pgvector")).toBe("pgvector/pgvector:pg17");
    expect(resolveServiceImage(def, "17-postgis")).toBe("postgis/postgis:17-3.5");
    expect(resolveServiceImage(def, "17-pgmq")).toBe(
      "ghcr.io/pgmq/pg17-pgmq:v1.11.1",
    );
    expect(resolveServiceImage(def, "17-pgvector-postgis-pgmq")).toBe(
      "nhost/postgres:17.10-20260610-1",
    );
    expect(generateEnvVars(def, "17-pgvector").POSTGRES_EXTENSIONS).toBe("vector");
    expect(generateEnvVars(def, "17-postgis").POSTGRES_EXTENSIONS).toBe("postgis");
    expect(generateEnvVars(def, "17-pgmq").POSTGRES_EXTENSIONS).toBe("pgmq");
    expect(generateEnvVars(def, "17-pgvector-postgis-pgmq").POSTGRES_EXTENSIONS).toBe(
      "vector,postgis,pgmq",
    );
    expect(resolveServiceImage(def, "17-alpine")).toBe("postgres:17-alpine");
  });
});
