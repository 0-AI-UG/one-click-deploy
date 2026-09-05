import { expect, test } from "bun:test";
import { authorizeObject } from "./storage-access.ts";

test("storage access fixes the prefix and rejects writes for read-only grants", () => {
  const grant = { prefix: "foody/", methods: ["GET", "HEAD"] as Array<"GET" | "HEAD"> };
  expect(authorizeObject(grant, { method: "GET", key: "uploads/a", bucket: "other-bucket", prefix: "other/" }).key).toBe("foody/uploads/a");
  expect(() => authorizeObject(grant, { method: "PUT", key: "uploads/a" })).toThrow();
  expect(() => authorizeObject(grant, { method: "GET", key: "../other/a" })).toThrow();
  expect(() => authorizeObject(grant, { method: "GET", key: "a", expiresIn: 86400 })).toThrow();
});
