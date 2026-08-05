import { describe, expect, test } from "bun:test";
import {
  GIB,
  assertDiskBudget,
  buildDiskBudget,
  transferDiskBudget,
} from "./disk-space.ts";

describe("deployment disk budgets", () => {
  test("source build reserves candidate + fallback archive + fixed safety space", () => {
    const budget = buildDiskBudget({
      availableBytes: 20 * GIB,
      contextBytes: 100 * 1024 ** 2,
      currentImageBytes: 4 * GIB,
      rollbackImageBytes: 3 * GIB,
      registryBacked: false,
    });
    expect(budget.imageBytes).toBe(4 * GIB);
    expect(budget.archiveBytes).toBe(4 * GIB);
    expect(budget.existingProtectedBytes).toBe(7 * GIB);
    expect(budget.requiredFreeBytes).toBe(10 * GIB);
  });

  test("registry-backed source build does not reserve fallback archive space", () => {
    const budget = buildDiskBudget({
      availableBytes: 20 * GIB,
      contextBytes: 10,
      currentImageBytes: 4 * GIB,
      rollbackImageBytes: 0,
      registryBacked: true,
    });
    expect(budget.archiveBytes).toBe(0);
    expect(budget.requiredFreeBytes).toBe(6 * GIB);
  });

  test("destination import includes archive, expanded layers, workspace, and reserve", () => {
    const budget = transferDiskBudget({
      availableBytes: 20 * GIB,
      imageBytes: 4 * GIB,
      archiveBytes: 2 * GIB,
      includeExpandedImage: true,
    });
    expect(budget.workspaceBytes).toBe(1 * GIB);
    expect(budget.requiredFreeBytes).toBe(9 * GIB);
  });

  test("fails in preflight with an actionable capacity breakdown", () => {
    const budget = transferDiskBudget({
      availableBytes: 3 * GIB,
      imageBytes: 4 * GIB,
      archiveBytes: 2 * GIB,
      includeExpandedImage: true,
    });
    expect(() => assertDiskBudget("Destination import", budget)).toThrow(
      /3\.0 GiB free.*9\.0 GiB required.*safety reserve/i,
    );
  });
});
