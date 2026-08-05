import { describe, expect, test } from "bun:test";
import { ApiError, describePanelTransportError } from "./api.ts";

describe("panel transport diagnostics", () => {
  test("distinguishes local trust-store failures from transient transport", () => {
    const detail = describePanelTransportError(
      Object.assign(new Error("unknown certificate verification error"), { code: "CERT_UNTRUSTED" }),
      "https://panel.example.com",
    );
    expect(detail.kind).toBe("local_trust_store");
    expect(detail.message).toContain("openssl s_client -showcerts");
    expect(new ApiError(0, "GET", "/api/apps", detail.message, detail.kind).isTransient).toBe(false);
  });

  test("classifies TLS resets as retryable", () => {
    const detail = describePanelTransportError(
      Object.assign(new Error("Connection reset by peer"), { code: "ECONNRESET" }),
      "https://panel.example.com",
    );
    expect(detail.kind).toBe("tls_transport_reset");
    expect(new ApiError(0, "GET", "/api/apps", detail.message, detail.kind).isTransient).toBe(true);
  });

  test("distinguishes refused panel connections", () => {
    const detail = describePanelTransportError(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      "https://panel.example.com",
    );
    expect(detail.kind).toBe("panel_unavailable");
  });
});
