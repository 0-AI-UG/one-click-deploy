import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../db.ts";
import connection from "./connection.ts";
import { enqueueOperation } from "./operations.ts";

function source() {
  const suffix = randomSuffix();
  const server = db.insertServer({
    name: `delivery-${suffix}`,
    provider_id: `delivery-${suffix}`,
    ipv4: "203.0.113.41",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  const worker = db.insertBuildWorker({
    serverId: server.id,
    name: `delivery-${suffix}`,
    previousPool: "general",
  });
  return db.upsertBuildSource({
    repository: `https://example.com/${suffix}.git`,
    branch: "main",
    workerId: worker.id,
  });
}

function operation() {
  return enqueueOperation({
    kind: "webhook_build_source",
    resourceKeys: [],
    input: {},
    trigger: "test",
  });
}

describe("build-source delivery persistence", () => {
  test("records an immutable delivery idempotently", () => {
    const buildSource = source();
    const input = {
      sourceId: buildSource.id,
      deliveryId: "delivery-1",
      commitSha: "a".repeat(40),
      eventAt: "2026-08-30T08:00:00.000Z",
    };
    const first = db.recordBuildSourceDelivery(input);
    const replay = db.recordBuildSourceDelivery(input);

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.delivery.id).toBe(first.delivery.id);
    expect(replay.delivery.status).toBe("received");
    expect(() => db.recordBuildSourceDelivery({ ...input, commitSha: "b".repeat(40) })).toThrow(
      "identity mismatch",
    );
  });

  test("attaches exactly one operation and enforces terminal status fencing", () => {
    const buildSource = source();
    db.recordBuildSourceDelivery({
      sourceId: buildSource.id,
      deliveryId: "delivery-attach",
      commitSha: "a".repeat(40),
    });
    const firstOperation = operation();
    const attached = db.attachBuildSourceDeliveryOperation({
      sourceId: buildSource.id,
      deliveryId: "delivery-attach",
      operationId: firstOperation.id,
    });
    expect(attached.operation_id).toBe(firstOperation.id);
    expect(attached.status).toBe("queued");
    expect(db.attachBuildSourceDeliveryOperation({
      sourceId: buildSource.id,
      deliveryId: "delivery-attach",
      operationId: firstOperation.id,
    }).operation_id).toBe(firstOperation.id);

    const secondOperation = operation();
    expect(() => db.attachBuildSourceDeliveryOperation({
      sourceId: buildSource.id,
      deliveryId: "delivery-attach",
      operationId: secondOperation.id,
    })).toThrow("another operation");

    db.updateBuildSourceDeliveryStatus({
      sourceId: buildSource.id,
      deliveryId: "delivery-attach",
      status: "building",
    });
    db.updateBuildSourceDeliveryStatus({
      sourceId: buildSource.id,
      deliveryId: "delivery-attach",
      status: "deployed",
    });
    expect(() => db.updateBuildSourceDeliveryStatus({
      sourceId: buildSource.id,
      deliveryId: "delivery-attach",
      status: "building",
    })).toThrow("Invalid build source delivery transition");
  });

  test("lists and atomically supersedes older queued deliveries", () => {
    const buildSource = source();
    for (const [deliveryId, hour] of [["old", "08"], ["middle", "09"], ["new", "10"]]) {
      db.recordBuildSourceDelivery({
        sourceId: buildSource.id,
        deliveryId,
        commitSha: deliveryId.padEnd(40, "a"),
        eventAt: `2026-08-30T${hour}:00:00.000Z`,
      });
      db.attachBuildSourceDeliveryOperation({
        sourceId: buildSource.id,
        deliveryId,
        operationId: operation().id,
      });
    }

    expect(db.listOlderQueuedBuildSourceDeliveries({
      sourceId: buildSource.id,
      newerDeliveryId: "new",
    }).map((row) => row.delivery_id)).toEqual(["middle", "old"]);
    expect(db.markOlderBuildSourceDeliveriesSuperseded({
      sourceId: buildSource.id,
      newerDeliveryId: "new",
    })).toBe(2);
    expect(db.listActiveBuildSourceDeliveries(buildSource.id).map((row) => row.delivery_id)).toEqual(["new"]);
    expect(db.getBuildSourceDelivery(buildSource.id, "old")?.superseded_by).toBe(
      db.getBuildSourceDelivery(buildSource.id, "new")?.id,
    );
  });

  test("does not supersede a build that has already started", () => {
    const buildSource = source();
    for (const [deliveryId, hour] of [["building", "08"], ["new", "10"]]) {
      db.recordBuildSourceDelivery({
        sourceId: buildSource.id,
        deliveryId,
        commitSha: deliveryId.padEnd(40, "a"),
        eventAt: `2026-08-30T${hour}:00:00.000Z`,
      });
    }
    db.updateBuildSourceDeliveryStatus({
      sourceId: buildSource.id,
      deliveryId: "building",
      status: "building",
    });
    expect(db.markOlderBuildSourceDeliveriesSuperseded({
      sourceId: buildSource.id,
      newerDeliveryId: "new",
    })).toBe(0);
    expect(db.getBuildSourceDelivery(buildSource.id, "building")?.status).toBe("building");
  });

  test("returns the latest delivery in event order including terminal rows", () => {
    const buildSource = source();
    db.recordBuildSourceDelivery({
      sourceId: buildSource.id,
      deliveryId: "received-later",
      commitSha: "a".repeat(40),
      eventAt: "2026-08-30T11:00:00.000Z",
    });
    db.recordBuildSourceDelivery({
      sourceId: buildSource.id,
      deliveryId: "deployed-latest",
      commitSha: "b".repeat(40),
      eventAt: "2026-08-30T12:00:00.000Z",
    });
    db.updateBuildSourceDeliveryStatus({
      sourceId: buildSource.id,
      deliveryId: "deployed-latest",
      status: "building",
    });
    db.updateBuildSourceDeliveryStatus({
      sourceId: buildSource.id,
      deliveryId: "deployed-latest",
      status: "deployed",
    });

    expect(db.getLatestBuildSourceDelivery(buildSource.id)?.delivery_id).toBe("deployed-latest");
  });

  test("compacts terminal history while retaining the newest rows and all active rows", () => {
    const buildSource = source();
    for (let index = 0; index < 105; index += 1) {
      const deliveryId = `terminal-${String(index).padStart(3, "0")}`;
      db.recordBuildSourceDelivery({
        sourceId: buildSource.id,
        deliveryId,
        commitSha: String(index).padStart(40, "0"),
        eventAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
      db.updateBuildSourceDeliveryStatus({
        sourceId: buildSource.id,
        deliveryId,
        status: "stale",
      });
    }
    db.recordBuildSourceDelivery({
      sourceId: buildSource.id,
      deliveryId: "active-old",
      commitSha: "f".repeat(40),
      eventAt: "2025-01-01T00:00:00.000Z",
    });

    expect(db.compactBuildSourceDeliveries(buildSource.id)).toBe(5);
    const rows = connection.query(
      "SELECT * FROM build_source_deliveries WHERE source_id = ? ORDER BY id",
    ).all(buildSource.id) as db.BuildSourceDeliveryRow[];
    expect(rows).toHaveLength(101);
    expect(rows.some((row) => row.delivery_id === "active-old")).toBe(true);
    expect(rows.some((row) => row.delivery_id === "terminal-000")).toBe(false);
    expect(rows.some((row) => row.delivery_id === "terminal-104")).toBe(true);
  });
});
