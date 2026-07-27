import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../db.ts";

describe("environment recovery lifecycle", () => {
  test("soft delete hides an environment, then restore makes it active again", () => {
    const environment = db.insertEnvironment(`recover-${randomSuffix()}`, "{}");
    db.softDeleteEnvironment(environment.id);

    expect(db.getEnvironment(environment.id)).toBeNull();
    const deleted = db.getDeletedEnvironment(environment.id);
    expect(deleted?.deleted_at).toBeTruthy();
    expect(deleted?.purge_after).toBeTruthy();
    expect(db.isEnvironmentPurgeProtected(deleted!)).toBe(true);

    db.restoreEnvironment(environment.id);
    expect(db.getEnvironment(environment.id)?.name).toBe(environment.name);
    expect(db.getDeletedEnvironment(environment.id)).toBeNull();
  });

  test("the seven-day window blocks purge until its protection timestamp", () => {
    const environment = { purge_after: "2026-07-27 12:00:00" };
    expect(db.isEnvironmentPurgeProtected(environment, Date.parse("2026-07-27T11:59:59Z"))).toBe(true);
    expect(db.isEnvironmentPurgeProtected(environment, Date.parse("2026-07-27T12:00:00Z"))).toBe(false);
  });

  test("hard deletion is reserved for purge of an already retired environment", () => {
    const environment = db.insertEnvironment(`purge-${randomSuffix()}`, "{}");
    db.softDeleteEnvironment(environment.id);
    db.deleteEnvironment(environment.id);
    expect(db.getDeletedEnvironment(environment.id)).toBeNull();
  });
});
