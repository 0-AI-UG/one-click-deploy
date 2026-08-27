import { describe, expect, test } from "bun:test";
import {
  ApiError,
  PanelRequestTimeoutError,
  apiRequest,
  describePanelTransportError,
  fetchPanelResponse,
  shouldRetryPanelTransport,
} from "./api.ts";

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

  test("bounds the response body download, not only response headers", async () => {
    let aborted = false;
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(init.signal?.reason);
          });
        },
      }));
    }) as unknown as typeof fetch;

    const startedAt = Date.now();
    await expect(fetchPanelResponse(fetcher, "https://panel.example.com/api/dashboard", {}, 20))
      .rejects.toBeInstanceOf(PanelRequestTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(aborted).toBe(true);
  });

  test("treats timeouts as retryable only for GET requests", () => {
    expect(shouldRetryPanelTransport("GET", "timeout")).toBe(true);
    expect(shouldRetryPanelTransport("POST", "timeout")).toBe(false);
  });

  test("reports the final timeout after a gateway response instead of retaining stale response state", async () => {
    let attempts = 0;
    const fetcher = (async () => {
      attempts++;
      if (attempts === 1) {
        return Response.json({ error: "temporary gateway" }, { status: 503 });
      }
      throw new PanelRequestTimeoutError(10);
    }) as unknown as typeof fetch;

    const request = apiRequest(
      "GET",
      "/api/dashboard?compact=1",
      undefined,
      undefined,
      {
        config: { panel_url: "https://panel.example.com", token: "test-token" },
        fetcher,
        sleep: async () => {},
        getTimeoutMs: 10,
      },
    );
    await expect(request).rejects.toMatchObject({ status: 0, transportKind: "timeout" });
    expect(attempts).toBe(3);
  });
});
