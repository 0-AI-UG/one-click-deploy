import { describe, expect, test } from "bun:test";
import { decodeJwt } from "jose";
import { createToken } from "./auth.ts";

function lifetimeDays(token: string): number {
  const payload = decodeJwt(token);
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("token is missing timestamps");
  }
  return (payload.exp - payload.iat) / 86_400;
}

describe("token lifetimes", () => {
  test("keeps browser sessions short", async () => {
    const token = await createToken({ userId: "user-1", username: "user" });
    expect(lifetimeDays(token)).toBe(7);
  });

  test("supports unattended device-authorized CLI automation", async () => {
    const token = await createToken({
      userId: "user-1",
      username: "user",
      client: "cli",
    });
    expect(lifetimeDays(token)).toBe(365);
  });
});
