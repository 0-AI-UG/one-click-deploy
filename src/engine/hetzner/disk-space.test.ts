import { describe, expect, test } from "bun:test";
import {
  GIB,
  assertDiskBudget,
  buildAdmissionLeaseCommand,
  buildDiskBudget,
  buildDeploymentPreflightGcCommand,
  parseDiskAdmissionDenial,
  shouldWaitForDiskAdmission,
  transferDiskBudget,
} from "./disk-space.ts";

describe("deployment disk budgets", () => {
  test("source build estimates from inputs so a smaller image can replace a large one", () => {
    const budget = buildDiskBudget({
      availableBytes: 20 * GIB,
      contextBytes: 100 * 1024 ** 2,
      currentImageBytes: 4 * GIB,
      rollbackImageBytes: 3 * GIB,
      registryBacked: false,
    });
    expect(budget.imageBytes).toBe(1 * GIB);
    expect(budget.archiveBytes).toBe(1 * GIB);
    expect(budget.existingProtectedBytes).toBe(7 * GIB);
    expect(budget.requiredFreeBytes).toBe(4 * GIB);
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
    expect(budget.requiredFreeBytes).toBe(3 * GIB);
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

  test("parses an admission denial caused by concurrent reservations", () => {
    const denial = parseDiskAdmissionDenial("OCD_DISK_DENIED 5000 2200 1800 2000\n");
    expect(denial).toEqual({
      freeBytes: 5000,
      otherReservedBytes: 2200,
      requestedBytes: 1800,
      safetyBytes: 2000,
    });
    expect(shouldWaitForDiskAdmission(denial)).toBe(true);
  });

  test("does not wait when admission proves physical capacity is insufficient", () => {
    const denial = parseDiskAdmissionDenial("OCD_DISK_DENIED 3000 0 1800 2000\n");
    expect(shouldWaitForDiskAdmission(denial)).toBe(false);
  });

  test("guarded source builds use one durable owner lease per host", () => {
    const command = buildAdmissionLeaseCommand("b-test");
    expect(command).toContain("/tmp/ocd-disk-admission.lock");
    expect(command).toContain("flock -x");
    expect(command).toContain("/tmp/ocd-build-admission.lease");
    expect(command).toContain("OCD_BUILD_BUSY");
    expect(command).toContain('owner" != "b-test');
  });

  test("preflight GC removes only unreferenced managed image IDs and fails closed", () => {
    const command = buildDeploymentPreflightGcCommand();
    expect(command).toContain("docker image ls -q --no-trunc | sort -u");
    expect(command).toContain("managed=${meta%%|*}");
    expect(command).toContain("image inspect");
    expect(command).toContain(") || continue");
    expect(command).toContain("latest");
    expect(command).toContain("rollback");
    expect(command).toContain('docker ps -aq --filter ancestor="$id"');
    expect(command).toContain('[ -n "$containers" ] && continue');
    expect(command).toContain('docker image rm "$id"');
    expect(command).not.toContain("docker image prune -af");
    expect(command).toContain("docker builder prune -f --filter until=24h");
  });
});
