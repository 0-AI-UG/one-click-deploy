import { describe, expect, test } from "bun:test";
import {
  handleConnectServer,
  handleGetServerEnrollmentKey,
  isIpv4,
  isPinnedEd25519HostKey,
} from "./servers.ts";

describe("external server enrollment validation", () => {
  test("accepts any valid IPv4 fleet route", () => {
    expect(isIpv4("203.0.113.10")).toBe(true);
    expect(isIpv4("10.42.0.8")).toBe(true);
    expect(isIpv4("999.1.1.1")).toBe(false);
  });

  test("accepts only a single address-bound Ed25519 known-hosts line", () => {
    const key = "A".repeat(68);
    expect(isPinnedEd25519HostKey("203.0.113.10", `203.0.113.10 ssh-ed25519 ${key}`)).toBe(true);
    expect(isPinnedEd25519HostKey("203.0.113.10", `other ssh-ed25519 ${key}`)).toBe(false);
    expect(isPinnedEd25519HostKey("203.0.113.10", `203.0.113.10 ssh-rsa ${key}`)).toBe(false);
    expect(isPinnedEd25519HostKey("203.0.113.10", `203.0.113.10 ssh-ed25519 ${key}\nevil ssh-ed25519 ${key}`)).toBe(false);
    expect(isPinnedEd25519HostKey("203.0.113.10", "203.0.113.10 ssh-ed25519 short")).toBe(false);
  });

  test("protects enrollment key and connection endpoints with server-create permission", async () => {
    const keyResponse = await handleGetServerEnrollmentKey(new Request("http://localhost/api/servers/enrollment-key"));
    expect(keyResponse.status).toBe(401);
    const connectResponse = await handleConnectServer(new Request("http://localhost/api/servers/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(connectResponse.status).toBe(401);
  });
});
