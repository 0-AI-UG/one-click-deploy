import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import { selectCurrentAndRollback } from "./app-storage.ts";

describe("app storage artifact selection", () => {
  test("skips runtime-only checkpoints when choosing rollback", () => {
    const rows = [
      { id: 3, status: "deployed", image_digest: "sha256:current", image_tag: "app:latest" },
      { id: 2, status: "deployed", image_digest: "sha256:current", image_tag: "app:latest" },
      { id: 1, status: "deployed", image_digest: "sha256:previous", image_tag: "app:old" },
    ];
    expect(selectCurrentAndRollback(rows)).toEqual({ current: rows[0], rollback: rows[2] });
  });
});
