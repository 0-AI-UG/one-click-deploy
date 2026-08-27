import { describe, expect, test } from "bun:test";
import { randomSuffix, useTempDataDir } from "../test-helpers.ts";

useTempDataDir();

import * as db from "../db.ts";

const IMAGE_A = `ghcr.io/acme/panel@sha256:${"a".repeat(64)}`;
const IMAGE_B = `ghcr.io/acme/panel@sha256:${"b".repeat(64)}`;

describe("panel immutable image contract", () => {
  test("stores the bootstrap digest and advances it with a deployed release", () => {
    db.deletePanel();
    const server = db.insertServer({
      name: `panel-${randomSuffix()}`,
      provider_id: `external-${randomSuffix()}`,
      ipv4: "192.0.2.10",
      ipv6: "",
      type: "external",
      location: "manual",
      status: "ready",
    });
    const panel = db.insertPanel({
      server_id: server.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      image_ref: IMAGE_A,
      container_port: 3001,
      host_port: 3001,
    });
    expect(panel.image_ref).toBe(IMAGE_A);

    db.insertPanelDeployment({ image_tag: IMAGE_B, git_commit: "abcdef0" });
    expect(db.getPanel()?.image_ref).toBe(IMAGE_B);
    expect(db.getPanelDeployments()[0].git_commit).toBe("abcdef0");
    db.deletePanel();
  });

  test("rejects mutable panel images", () => {
    const server = db.insertServer({
      name: `panel-${randomSuffix()}`,
      provider_id: `external-${randomSuffix()}`,
      ipv4: "192.0.2.11",
      ipv6: "",
      type: "external",
      location: "manual",
      status: "ready",
    });
    expect(() => db.insertPanel({
      server_id: server.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      image_ref: "ghcr.io/acme/panel:latest",
      container_port: 3001,
      host_port: 3001,
    })).toThrow(/immutable OCI reference/);
  });
});
