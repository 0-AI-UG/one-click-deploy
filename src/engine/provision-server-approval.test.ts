import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();

import { expect, test } from "bun:test";
import * as db from "../shared/db.ts";
import { provisionServer } from "./provision-server.ts";

test("automatic provisioning stops before creating provider or DB resources without browser approval", async () => {
  const before = db.getServers().length;
  await expect(provisionServer({
    serverType: "cx22",
    location: "fsn1",
    approved: false,
    emit: () => {},
  })).rejects.toThrow("requires browser approval");
  expect(db.getServers().length).toBe(before);
});
