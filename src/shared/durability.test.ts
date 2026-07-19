// Unit tests for resolveDurability — the pure durability_class → concrete
// placement/replica-floor mapping. These pin the truth table the placement
// layer (server-picker) and the availability sampler both rely on; a change to
// the mapping (or the desiredReplicas floor) breaks here first.
import { describe, test, expect } from "bun:test";
import { resolveDurability } from "./durability.ts";

describe("resolveDurability", () => {
  test("none → no cap, single location, no replica floor", () => {
    const r = resolveDurability("none", undefined);
    expect(r.durabilityClass).toBe("none");
    expect(r.maxPerHost).toBe(0);
    expect(r.minLocations).toBe(1);
    expect(r.minReplicas).toBe(1);
  });

  test("standard → 1 per host, single location, >= 2 replicas", () => {
    const r = resolveDurability("standard", undefined);
    expect(r.durabilityClass).toBe("standard");
    expect(r.maxPerHost).toBe(1);
    expect(r.minLocations).toBe(1);
    expect(r.minReplicas).toBe(2);
  });

  test("high → 1 per host, >= 2 locations, >= 2 replicas", () => {
    const r = resolveDurability("high", undefined);
    expect(r.durabilityClass).toBe("high");
    expect(r.maxPerHost).toBe(1);
    expect(r.minLocations).toBe(2);
    expect(r.minReplicas).toBe(2);
  });

  test("unknown class is treated as none", () => {
    const r = resolveDurability("gold", undefined);
    expect(r.durabilityClass).toBe("none");
    expect(r.maxPerHost).toBe(0);
    expect(r.minLocations).toBe(1);
    expect(r.minReplicas).toBe(1);
  });

  test("undefined class is treated as none", () => {
    const r = resolveDurability(undefined, undefined);
    expect(r.durabilityClass).toBe("none");
    expect(r.minReplicas).toBe(1);
  });

  test("desiredReplicas floors the request to the class minimum", () => {
    // standard floor is 2 → a request for 1 comes up redundant.
    expect(resolveDurability("standard", 1).desiredReplicas).toBe(2);
    // request above the floor is preserved.
    expect(resolveDurability("high", 5).desiredReplicas).toBe(5);
    // none has floor 1, and an omitted request defaults to 1.
    expect(resolveDurability("none", undefined).desiredReplicas).toBe(1);
  });
});
