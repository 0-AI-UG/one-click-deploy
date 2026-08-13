import { describe, expect, test } from "bun:test";
import { ApiError, describePanelTransportError, shouldRetryPanelTransport } from "./api.ts";

describe("panel transport diagnostics", () => {
  test("retries Bun's generic unknown certificate verification failure", () => {
    const detail = describePanelTransportError(
      Object.assign(new Error("unknown certificate verification error"), { code: "CERT_UNTRUSTED" }),
      "https://panel.example.com",
    );
    expect(detail.kind).toBe("unknown_certificate_verification");
    expect(detail.message).toContain("openssl s_client -showcerts");
    expect(new ApiError(0, "GET", "/api/apps", detail.message, detail.kind).isTransient).toBe(true);
    expect(new ApiError(0, "POST", "/api/apps", detail.message, detail.kind).isTransient).toBe(false);
    expect(shouldRetryPanelTransport("GET", detail.kind)).toBe(true);
    expect(shouldRetryPanelTransport("POST", detail.kind)).toBe(false);
  });

  test("keeps explicit trust-chain failures permanent and actionable", () => {
    const detail = describePanelTransportError(
      Object.assign(new Error("unable to get local issuer certificate"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }),
      "https://panel.example.com",
    );
    expect(detail.kind).toBe("local_trust_store");
    expect(detail.message).toContain("openssl s_client -showcerts");
    expect(new ApiError(0, "GET", "/api/apps", detail.message, detail.kind).isTransient).toBe(false);
    expect(shouldRetryPanelTransport("GET", detail.kind)).toBe(false);
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
