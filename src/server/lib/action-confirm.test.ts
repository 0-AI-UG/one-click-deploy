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

describe("enforceConfirmation browser-only approval", () => {
  test("returns an exact confirmation requirement when approval is missing", async () => {
    const request = new Request("http://localhost/api/resources/servers", { method: "POST" });
    try {
      await enforceConfirmation(request, cliUser, "create_server", "server_plan", "plan-42");
      throw new Error("expected confirmation rejection");
    } catch (error) {
      expect(error).toMatchObject({
        requirement: {
          action: "create_server",
          resource_type: "server_plan",
          resource_id: "plan-42",
        },
      });
    }
  });

  test("rejects the former operation-cancel automation approval", async () => {
    const request = new Request("https://panel.test/api/operations/1290/cancel", {
      method: "POST",
      headers: { "x-ocd-confirmation": "automation:cancel_operation:operation:1290" },
    });
    await expect(
      enforceConfirmation(request, cliUser, "cancel_operation", "operation", "1290"),
    ).rejects.toThrow("Confirmation invalid");
  });

  test("rejects the former action-and-resource-bound automation token", async () => {
    const request = new Request("http://localhost/api/apps/42", {
      headers: { "x-ocd-confirmation": "automation:delete_app:app:42" },
    });
    await expect(
      enforceConfirmation(request, cliUser, "delete_app", "app", "42"),
    ).rejects.toThrow("Confirmation invalid");
  });

  test("rejects an automation token for a different resource", async () => {
    const request = new Request("http://localhost/api/apps/42", {
      headers: { "x-ocd-confirmation": "automation:delete_app:app:41" },
    });
    await expect(
      enforceConfirmation(request, cliUser, "delete_app", "app", "42"),
    ).rejects.toThrow("Confirmation invalid");
  });

  test("rejects a bare authenticated browser DELETE for permanent volume data", async () => {
    const request = new Request("http://localhost/api/resources/volume/42", {
      method: "DELETE",
    });
    await expect(
      enforceConfirmation(request, webUser, "delete_volume", "volume", "42"),
    ).rejects.toThrow("server-issued browser confirmation");
  });

  test("rejects a bare authenticated browser app deletion", async () => {
    const request = new Request("http://localhost/api/apps/42", { method: "DELETE" });
    await expect(
      enforceConfirmation(request, webUser, "delete_app", "app", "42"),
    ).rejects.toThrow("server-issued browser confirmation");
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
