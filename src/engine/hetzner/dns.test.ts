import { beforeEach, describe, expect, mock, test } from "bun:test";

const api = mock(async (_path: string, _options?: RequestInit): Promise<any> => ({}));
import { createDnsRecord } from "./dns.ts";

beforeEach(() => api.mockClear());

describe("Hetzner DNS RRSet convergence", () => {
  test("does nothing only for an exact single-value RRSet", async () => {
    api.mockImplementationOnce(async () => ({ rrset: { records: [{ value: "203.0.113.10" }] } }));

    await createDnsRecord({ zone_id: "z", name: "app", type: "A", value: "203.0.113.10" }, api);

    expect(api).toHaveBeenCalledTimes(1);
  });

  test("replaces an RRSet that contains the desired value plus stale values", async () => {
    api.mockImplementationOnce(async () => ({
      rrset: { records: [{ value: "203.0.113.10" }, { value: "198.51.100.9" }] },
    }));
    api.mockImplementation(async () => ({}));

    await createDnsRecord({ zone_id: "z", name: "app", type: "A", value: "203.0.113.10" }, api);

    expect(api).toHaveBeenCalledTimes(3);
    expect(api.mock.calls[1][1]?.method).toBe("DELETE");
    expect(api.mock.calls[2][1]?.method).toBe("POST");
  });

  test("does not reinterpret a provider read failure as record absence", async () => {
    api.mockImplementationOnce(async () => { throw new Error("provider unavailable"); });

    await expect(createDnsRecord({
      zone_id: "z",
      name: "app",
      type: "A",
      value: "203.0.113.10",
    }, api)).rejects.toThrow("provider unavailable");
    expect(api).toHaveBeenCalledTimes(1);
  });
});
