import { describe, expect, test } from "bun:test";
import {
  assertAdoptableServiceVolume,
  serviceVolumeName,
} from "./deploy-service.ts";
import deployServiceOp from "./deploy-service.ts";
import { FatalProbeError } from "../types.ts";
import * as db from "../../shared/db.ts";
import { parseEnvVars, serializeEnvVars } from "../../shared/env-crypto.ts";

describe("deploy_service volume identity", () => {
  test("new service volumes are immutable-operation scoped", () => {
    expect(serviceVolumeName("postgres", 41)).toBe("ocd-svc-postgres-op41");
    expect(serviceVolumeName("postgres", 41)).not.toBe(serviceVolumeName("postgres", 42));
  });

  test("rejects retained and mismatched same-name volumes instead of adopting them", () => {
    const volume = {
      providerId: "vol-old",
      sizeGb: 10,
      location: "fsn1",
      serverId: null,
    };
    expect(() => assertAdoptableServiceVolume(
      volume,
      { sizeGb: 10, location: "fsn1", serverId: "srv-1" },
      [{
        provider_volume_id: "vol-old",
        former_resource_type: "service",
        former_resource_name: "postgres",
      }],
    )).toThrow(/Refusing to adopt retained volume/);

    expect(() => assertAdoptableServiceVolume(
      { ...volume, providerId: "vol-wrong", sizeGb: 20 },
      { sizeGb: 10, location: "fsn1", serverId: "srv-1" },
      [],
    )).toThrow(/does not match/);
  });

  test("classifies unsafe volume adoption as a fatal probe result", () => {
    expect(() => assertAdoptableServiceVolume(
      { providerId: "foreign", sizeGb: 20, location: "fsn1", serverId: null },
      { sizeGb: 10, location: "fsn1", serverId: "srv-1" },
      [],
    )).toThrow(FatalProbeError);
  });
});

describe("deploy_service durable boundaries", () => {
  test("registers service and primary instance atomically", () => {
    const server = db.insertServer({
      name: "service-atomic-host",
      provider_id: "provider-service-atomic-host",
      ipv4: "192.0.2.25",
      ipv6: "",
      type: "cx23",
      location: "fsn1",
      status: "ready",
    });

    const registered = db.insertServiceWithPrimaryInstance((hostPort) => ({
      name: "service-atomic-ok",
      service_type: "redis",
      version: "7",
      port: 6379,
      env_vars: JSON.stringify({ ALLOCATED_PORT: String(hostPort) }),
      credentials: JSON.stringify({ port: hostPort }),
    }), {
      server_id: server.id,
      role: "primary",
      container_name: "service-atomic-ok",
    });

    expect(registered.instance.service_id).toBe(registered.service.id);
    expect(JSON.parse(registered.service.credentials).port).toBe(registered.instance.host_port);
    expect(JSON.parse(registered.service.env_vars).ALLOCATED_PORT).toBe(String(registered.instance.host_port));

    expect(() => db.insertServiceWithPrimaryInstance({
      name: "service-atomic-rollback",
      service_type: "redis",
      version: "7",
      port: 6379,
      env_vars: "{}",
      credentials: "{}",
    }, {
      server_id: -999,
      role: "primary",
      container_name: "service-atomic-rollback",
    })).toThrow();
    expect(db.getServiceByName("service-atomic-rollback")).toBeNull();
  });

  test("orders publication after readiness, initialization, stability, and ingress", () => {
    const names = deployServiceOp.steps.map((step) => step.name);
    expect(names).toEqual([
      "pick_or_provision_server",
      "create_volume",
      "insert_service_and_instance",
      "setup_volume_bind_mount",
      "pull_and_run_container",
      "health_check",
      "post_start_setup",
      "stability_check",
      "configure_http_ingress",
      "inject_env_credentials",
    ]);
    expect(deployServiceOp.steps.find((step) => step.name === "insert_service_and_instance")?.probe).toBeFunction();
    expect(deployServiceOp.steps.find((step) => step.name === "pull_and_run_container")?.probe).toBeFunction();
    expect(deployServiceOp.steps.at(-1)?.name).toBe("inject_env_credentials");
    expect(deployServiceOp.resourceKeys({
      name: "redis-with-env",
      service_type: "redis",
      environment_id: 42,
    })).toContain("env:42");
  });

  test("publishes environment credentials atomically and restores the exact prior state", async () => {
    const server = db.insertServer({
      name: "service-credential-host",
      provider_id: "provider-service-credential-host",
      ipv4: "192.0.2.26",
      ipv6: "",
      type: "cx23",
      location: "fsn1",
      status: "ready",
    });
    const registered = db.insertServiceWithPrimaryInstance({
      name: "service-credential-test",
      service_type: "postgresql",
      version: "17",
      port: 5432,
      env_vars: "{}",
      credentials: "{}",
    }, {
      server_id: server.id,
      role: "primary",
      container_name: "service-credential-test",
    });
    const originalEnvVars = serializeEnvVars([{
      key: "DATABASE_HOST",
      value: "old-host",
      secret: false,
      updated_at: "2026-01-01T00:00:00.000Z",
    }, {
      key: "UNRELATED",
      value: "preserve-me",
      secret: false,
      updated_at: "2026-01-01T00:00:00.000Z",
    }]);
    const environment = db.insertEnvironment("credential-target", originalEnvVars);
    const inject = deployServiceOp.steps.find((step) => step.name === "inject_env_credentials")!;
    const input = {
      name: "service-credential-test",
      service_type: "postgresql",
      environment_id: environment.id,
      env_prefix: "DATABASE",
    };
    const ctx = { input, log: () => {} } as any;
    const prior = {
      insert_service_and_instance: {
        serviceId: registered.service.id,
        instanceId: registered.instance.id,
        credentials: {
          connection_url: "postgresql://new-user:new-password@service:5432/new-db",
          host: "service.svc.ocd.internal",
          port: 5432,
          username: "new-user",
          password: "new-password",
          database: "new-db",
        },
      },
    };

    const out = await inject.run(ctx, prior);
    const published = parseEnvVars(db.getEnvironment(environment.id)!.env_vars);
    expect(published.entries.find((entry) => entry.key === "DATABASE_HOST")?.value)
      .toBe("service.svc.ocd.internal");
    expect(published.entries.find((entry) => entry.key === "UNRELATED")?.value).toBe("preserve-me");
    expect(db.getServiceLinks(registered.service.id)).toHaveLength(1);
    expect(await inject.probe!(ctx, prior)).toMatchObject({ injected: true });

    await inject.compensate!(ctx, out, prior);
    expect(db.getEnvironment(environment.id)!.env_vars).toBe(originalEnvVars);
    expect(db.getServiceLinks(registered.service.id)).toHaveLength(0);
  });
});
