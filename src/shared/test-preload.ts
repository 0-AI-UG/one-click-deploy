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

process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-test-"));
