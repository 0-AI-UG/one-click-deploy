import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeCurrentSchema, CURRENT_SCHEMA_VERSION } from "../../shared/db/current-schema.ts";
import { createDatabase } from "../../shared/db/connection.ts";

test("old layouts require an explicit offline cutover; current schema opens without changing settings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ocd-protection-schema-"));
  const filename = path.join(dir, "deploy.db");
  try {
    const old = new Database(filename);
    initializeCurrentSchema(old);
    old.run("INSERT INTO settings (key,value) VALUES ('existing','preserved')"); old.close();
    const upgraded = createDatabase(filename);
    expect(upgraded.query("SELECT version FROM schema_version").get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    expect(upgraded.query("SELECT value FROM settings WHERE key='existing'").get()).toEqual({ value: "preserved" });
    expect(upgraded.query("SELECT count(*) AS n FROM panel_backups").get()).toEqual({ n: 0 });
    upgraded.run("UPDATE schema_version SET version=114"); upgraded.close();
    expect(() => createDatabase(filename)).toThrow("offline cutover");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
