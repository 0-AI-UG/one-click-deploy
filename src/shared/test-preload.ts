// bun test preload (wired via bunfig.toml) — runs before any test file's
// imports are evaluated. ESM import hoisting means paths.ts (which freezes
// DATA_DIR) and db/connection.ts (which opens the SQLite DB at module eval)
// run before a test file's first statement, so setting OCD_DATA_DIR inside a
// test file is always too late. This preload is the only place early enough
// to point the whole test process at a throwaway data dir — without it,
// tests silently read and write the developer's real ~/.ocp/deploy.db.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { beforeEach } from "bun:test";

process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-test-"));

// The whole `bun test` process shares ONE SQLite DB — the db module is a
// singleton opened (at import) against the OCD_DATA_DIR set above, and bun runs
// every test file in that single process. Historically the only isolation was
// convention: unique row names + hand-written cleanup, including FK-cascade
// footguns. That leaks. Rows a file forgets to delete stay visible to every
// later test, and because bun's file execution order differs between machines
// it fails nondeterministically — passing locally, failing on CI. The failures
// were exactly this: renderDynamicConfig reads every row so leaked state
// dropped a fixture from collectDesiredState, and a stale child row tripped a
// FOREIGN KEY sweep in pick_or_provision_server.
//
// Wiping every table before each test makes each test independent of whatever
// ran before it. Safe because no unit-test file seeds DB rows at import time
// nor relies on cross-test persistence — fixtures are created inside each test
// (or its own beforeEach, which registers deeper and so runs after this one).
//
// The exception is the integration suites, which DO provision real resources in
// `beforeAll` and read the resulting DB rows across tests within a file — a
// per-test wipe would delete that state out from under them. They only actually
// run (rather than describe.skip) when their gating env is present, so mirror
// that condition and skip the wipe exactly then. Under a normal `bun test`
// (CI included) the wipe is active.
const RUNNING_INTEGRATION =
  (process.env.RUN_INTEGRATION === "1" && !!process.env.HCLOUD_TOKEN) ||
  process.env.RUN_ENGINE_INTEGRATION === "1";

// schema_version holds the applied-migration count and must survive; sqlite_*
// are engine internals. Everything else is test data and gets cleared.
const PRESERVE = new Set(["schema_version"]);

if (!RUNNING_INTEGRATION) {
  beforeEach(async () => {
    // Dynamic import: a static import would be hoisted above the OCD_DATA_DIR
    // assignment above and open the DB against the wrong dir. By the time this
    // hook first runs, a test file has already imported (and opened) the db.
    const { default: db } = await import("./db/index.ts");
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    // Toggle FKs off so wipe order doesn't matter (can't change this pragma
    // inside a transaction, so it runs outside one).
    db.run("PRAGMA foreign_keys = OFF");
    for (const { name } of tables) {
      if (PRESERVE.has(name)) continue;
      db.run(`DELETE FROM "${name}"`);
    }
    db.run("PRAGMA foreign_keys = ON");
  });
}
