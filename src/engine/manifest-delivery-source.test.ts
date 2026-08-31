import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../shared/db.ts";
import { secretStore } from "../shared/secret-store.ts";
import { commitManifestDeliverySource } from "./manifest-delivery-source.ts";

const IMAGE = `ghcr.io/acme/app@sha256:${"a".repeat(64)}`;

function seedBuildSource() {
  const suffix = randomSuffix();
  const server = db.insertServer({
    name: `source-${suffix}`,
    provider_id: `source-${suffix}`,
    ipv4: `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  const worker = db.insertBuildWorker({ serverId: server.id, name: `worker-${suffix}`, previousPool: "general" });
  const source = db.upsertBuildSource({
    repository: `https://github.com/acme/${suffix}.git`,
    branch: "main",
    workerId: worker.id,
  });
  return source;
}

function seedApp(name: string, sourceId?: number) {
  const app = db.insertApp({
    name: `${name}-${randomSuffix()}`,
    domain: "",
    image_ref: IMAGE,
    container_port: 3000,
    env_vars: "{}",
  });
  if (sourceId != null) {
    db.updateAppBuildConfig(app.id, {
      sourceId,
      repository: db.getBuildSource(sourceId)!.repository,
      branch: "main",
      dockerfile: "Dockerfile",
      context: ".",
      imageRepository: `ghcr.io/acme/${app.name}`,
    });
  }
  return app;
}

describe("manifest delivery-source persistence", () => {
  test("build to image detaches the app and removes an orphaned webhook source", async () => {
    const source = seedBuildSource();
    const app = seedApp("switch-image", source.id);
    await secretStore.set(`build_source_webhook:${source.id}`, "secret");

    await commitManifestDeliverySource(app.id, "image");

    expect(db.getApp(app.id)).toMatchObject({
      build_source_id: null,
      build_repository: "",
      build_image: "",
    });
    expect(db.getBuildSource(source.id)).toBeNull();
    expect(await secretStore.get(`build_source_webhook:${source.id}`)).toBeNull();
  });

  test("a shared source remains until its last app switches to image delivery", async () => {
    const source = seedBuildSource();
    const first = seedApp("first", source.id);
    const second = seedApp("second", source.id);
    await secretStore.set(`build_source_webhook:${source.id}`, "secret");

    await commitManifestDeliverySource(first.id, "image");
    expect(db.getBuildSource(source.id)).not.toBeNull();
    expect(await secretStore.get(`build_source_webhook:${source.id}`)).toBe("secret");

    await commitManifestDeliverySource(second.id, "image");
    expect(db.getBuildSource(source.id)).toBeNull();
  });

  test("image-backed apps can be attached to a build source after a successful build", () => {
    const source = seedBuildSource();
    const app = seedApp("switch-build");
    db.updateAppBuildConfig(app.id, {
      sourceId: source.id,
      repository: source.repository,
      branch: source.branch,
      dockerfile: "Dockerfile",
      context: ".",
      imageRepository: `ghcr.io/acme/${app.name}`,
    });
    expect(db.getApp(app.id)).toMatchObject({
      build_source_id: source.id,
      build_repository: source.repository,
      build_image: `ghcr.io/acme/${app.name}`,
    });
  });
});
