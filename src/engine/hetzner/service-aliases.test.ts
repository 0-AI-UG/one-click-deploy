import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import { currentServiceAliases } from "./docker-run.ts";
import { appReplicaRunOpts } from "../scale/types.ts";

describe("managed-service aliases on every app container create/recreate", () => {
  test("resolves PostgreSQL and Redis aliases to their service hosts", () => {
    const suffix = randomSuffix();
    const pgHost = db.insertServer({
      name: `pg-host-${suffix}`,
      provider_id: `pg-${suffix}`,
      ipv4: "192.0.2.8",
      ipv6: "",
      private_ipv4: "10.0.0.8",
      type: "cx22",
      location: "fsn1",
      status: "ready",
    });
    const redisHost = db.insertServer({
      name: `redis-host-${suffix}`,
      provider_id: `redis-${suffix}`,
      ipv4: "192.0.2.9",
      ipv6: "",
      private_ipv4: "10.0.0.9",
      type: "cx22",
      location: "fsn1",
      status: "ready",
    });
    const pg = db.insertService({
      name: `postgres-${suffix}`,
      service_type: "postgresql",
      version: "17",
      port: 5432,
      env_vars: "{}",
      credentials: "{}",
    });
    const redis = db.insertService({
      name: `redis-${suffix}`,
      service_type: "redis",
      version: "7",
      port: 6379,
      env_vars: "{}",
      credentials: "{}",
    });
    db.insertServiceInstance({
      service_id: pg.id,
      server_id: pgHost.id,
      role: "primary",
      container_name: `postgres-${suffix}`,
      host_port: 15432,
    });
    db.insertServiceInstance({
      service_id: redis.id,
      server_id: redisHost.id,
      role: "primary",
      container_name: `redis-${suffix}`,
      host_port: 16379,
    });

    expect(currentServiceAliases()).toEqual(expect.arrayContaining([
      { hostname: `postgres-${suffix}.svc.ocd.internal`, address: "10.0.0.8" },
      { hostname: `redis-${suffix}.svc.ocd.internal`, address: "10.0.0.9" },
    ]));

    const app = db.insertApp({
      name: `api-${suffix}`,
      domain: `api-${suffix}.example.com`,
      git_repo: "https://github.com/example/api",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    const reloadOpts = appReplicaRunOpts(app, pgHost, {
      containerName: app.name,
      hostPort: 30001,
      envVars: { DATABASE_URL: "redacted", REDIS_URL: "redacted" },
    });
    expect(reloadOpts.network).toBe("ocd-net");
    expect(currentServiceAliases()).toEqual(expect.arrayContaining([
      { hostname: `postgres-${suffix}.svc.ocd.internal`, address: "10.0.0.8" },
      { hostname: `redis-${suffix}.svc.ocd.internal`, address: "10.0.0.9" },
    ]));
  });
});
