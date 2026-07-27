import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import type { TokenPayload } from "./auth.ts";
import {
  createConfirmation,
  enforceConfirmation,
  resolveConfirmation,
} from "./action-confirm.ts";

const cliUser: TokenPayload = {
  userId: "automation-user",
  username: "automation",
  client: "cli",
};
const webUser: TokenPayload = {
  userId: "browser-user",
  username: "browser",
};

describe("enforceConfirmation automation approval", () => {
  test("accepts an exact operation-cancel automation approval", async () => {
    const request = new Request("https://panel.test/api/operations/1290/cancel", {
      method: "POST",
      headers: { "x-ocd-confirmation": "automation:cancel_operation:operation:1290" },
    });
    await expect(
      enforceConfirmation(request, cliUser, "cancel_operation", "operation", "1290"),
    ).resolves.toBeUndefined();
  });

  test("accepts an exact action-and-resource-bound automation token", async () => {
    const request = new Request("http://localhost/api/apps/42", {
      headers: { "x-ocd-confirmation": "automation:delete_app:app:42" },
    });
    await expect(
      enforceConfirmation(request, cliUser, "delete_app", "app", "42"),
    ).resolves.toBeUndefined();
  });

  test("rejects an automation token for a different resource", async () => {
    const request = new Request("http://localhost/api/apps/42", {
      headers: { "x-ocd-confirmation": "automation:delete_app:app:41" },
    });
    await expect(
      enforceConfirmation(request, cliUser, "delete_app", "app", "42"),
    ).rejects.toThrow("Confirmation invalid");
  });

  for (const [action, resourceType] of [
    ["delete_stack", "stack"],
    ["delete_environment", "environment"],
    ["purge_environment", "environment"],
    ["delete_volume", "volume"],
  ] as const) {
    test(`requires web UI approval for ${action} even with an automation token`, async () => {
      const request = new Request("http://localhost/api/destructive/42", {
        headers: { "x-ocd-confirmation": `automation:${action}:${resourceType}:42` },
      });
      await expect(
        enforceConfirmation(request, cliUser, action, resourceType, "42"),
      ).rejects.toThrow("always requires confirmation");
    });
  }

  test("rejects a bare authenticated browser DELETE for permanent volume data", async () => {
    const request = new Request("http://localhost/api/resources/volume/42", {
      method: "DELETE",
    });
    await expect(
      enforceConfirmation(request, webUser, "delete_volume", "volume", "42"),
    ).rejects.toThrow("server-issued browser confirmation");
  });

  test("retains the historical browser pass-through for lower-risk app deletion", async () => {
    const request = new Request("http://localhost/api/apps/42", { method: "DELETE" });
    await expect(
      enforceConfirmation(request, webUser, "delete_app", "app", "42"),
    ).resolves.toBeUndefined();
  });

  test("consumes an exact server-issued browser confirmation once", async () => {
    const confirmation = createConfirmation(
      webUser,
      "delete_volume",
      "volume",
      "42",
      "Delete volume 42",
    );
    expect(resolveConfirmation(confirmation.userCode, webUser, "confirmed")).toBe(true);
    const request = new Request("http://localhost/api/resources/volume/42", {
      method: "DELETE",
      headers: { "x-ocd-confirmation": confirmation.confirmCode },
    });
    await expect(
      enforceConfirmation(request, webUser, "delete_volume", "volume", "42"),
    ).resolves.toBeUndefined();
    await expect(
      enforceConfirmation(request, webUser, "delete_volume", "volume", "42"),
    ).rejects.toThrow("Confirmation invalid");
  });
});
