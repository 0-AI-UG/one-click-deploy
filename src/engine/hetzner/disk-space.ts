import { sshExec } from "./ssh.ts";
import {
  asUser,
  OCD_IMAGE_LABEL,
  withExclusiveImageGc,
} from "./container-common.ts";

export const GIB = 1024 ** 3;
export const HOST_SAFETY_RESERVE_BYTES = 2 * GIB;
export const IMPORT_WORKSPACE_RATIO = 0.25;

export type DiskBudget = {
  availableBytes: number;
  requiredFreeBytes: number;
  imageBytes: number;
  archiveBytes: number;
  workspaceBytes: number;
  existingProtectedBytes: number;
  safetyReserveBytes: number;
};

export function formatBytes(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

export function buildDiskBudget(input: {
  availableBytes: number;
  contextBytes: number;
  currentImageBytes: number;
  rollbackImageBytes: number;
  registryBacked: boolean;
  safetyReserveBytes?: number;
}): DiskBudget {
  // A first build has no image to inspect, so use a deliberately conservative
  // floor. For a redeploy, the current/rollback image is the best available
  // estimate of the candidate's expanded size. Build context is doubled to
  // account for COPY plus generated dependency/build output.
  const imageBytes = Math.max(
    GIB,
    input.contextBytes * 2,
    input.currentImageBytes,
    input.rollbackImageBytes,
  );
  const archiveBytes = input.registryBacked ? 0 : imageBytes;
  const safetyReserveBytes = input.safetyReserveBytes ?? HOST_SAFETY_RESERVE_BYTES;
  return {
    availableBytes: input.availableBytes,
    requiredFreeBytes: imageBytes + archiveBytes + safetyReserveBytes,
    imageBytes,
    archiveBytes,
    workspaceBytes: 0,
    existingProtectedBytes: input.currentImageBytes + input.rollbackImageBytes,
    safetyReserveBytes,
  };
}

export function transferDiskBudget(input: {
  availableBytes: number;
  imageBytes: number;
  archiveBytes: number;
  existingProtectedBytes?: number;
  includeExpandedImage: boolean;
  safetyReserveBytes?: number;
}): DiskBudget {
  const workspaceBytes = input.includeExpandedImage
    ? Math.ceil(input.imageBytes * IMPORT_WORKSPACE_RATIO)
    : 0;
  const safetyReserveBytes = input.safetyReserveBytes ?? HOST_SAFETY_RESERVE_BYTES;
  return {
    availableBytes: input.availableBytes,
    requiredFreeBytes:
      input.archiveBytes +
      (input.includeExpandedImage ? input.imageBytes : 0) +
      workspaceBytes +
      safetyReserveBytes,
    imageBytes: input.imageBytes,
    archiveBytes: input.archiveBytes,
    workspaceBytes,
    existingProtectedBytes: input.existingProtectedBytes ?? 0,
    safetyReserveBytes,
  };
}

export function assertDiskBudget(label: string, budget: DiskBudget): void {
  if (budget.availableBytes >= budget.requiredFreeBytes) return;
  throw new Error(
    `${label} disk preflight failed: ${formatBytes(budget.availableBytes)} free, ` +
      `${formatBytes(budget.requiredFreeBytes)} required ` +
      `(image ${formatBytes(budget.imageBytes)}, archive ${formatBytes(budget.archiveBytes)}, ` +
      `temporary workspace ${formatBytes(budget.workspaceBytes)}, ` +
      `safety reserve ${formatBytes(budget.safetyReserveBytes)}; ` +
      `${formatBytes(budget.existingProtectedBytes)} of current/rollback images is protected)`,
  );
}

async function availableBytes(ip: string, hostKey?: string): Promise<number> {
  const result = await sshExec(
    ip,
    "df -PB1 / | awk 'NR==2 {print $4}'",
    hostKey,
  );
  const value = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Could not determine free root-disk space on ${ip}`);
  }
  return value;
}

async function imageSize(ip: string, imageRef: string, hostKey?: string): Promise<number> {
  const result = await sshExec(
    ip,
    asUser(
      `docker image inspect --format '{{.Size}}' ${JSON.stringify(imageRef)} 2>/dev/null || echo 0`,
    ),
    hostKey,
  );
  return Math.max(0, Number(result.stdout.trim()) || 0);
}

/**
 * Operation-safe, bounded garbage collection. It removes only reconstructible
 * state: abandoned OCD transfer archives, dangling OCD-labelled image data,
 * and BuildKit cache older than one day. Current/rollback tags and containers
 * are never candidates. The image-GC lock serializes this with builds/runs.
 */
export async function runDeploymentPreflightGc(ip: string, hostKey?: string): Promise<void> {
  await sshExec(
    ip,
    "find /tmp -maxdepth 1 -type f -name 'ocd-image-*.tar.gz' -mmin +180 -delete 2>/dev/null || true",
    hostKey,
  );
  const command = [
    `docker image prune -f --filter label=${OCD_IMAGE_LABEL} 2>/dev/null || true`,
    "docker builder prune -f --filter until=24h 2>/dev/null || true",
  ].join("; ");
  await sshExec(ip, asUser(withExclusiveImageGc(command)), hostKey);
}

export async function preflightBuildDiskSpace(opts: {
  ip: string;
  appName: string;
  contextPath: string;
  registryBacked: boolean;
  hostKey?: string;
  onProgress?: (line: string) => void;
}): Promise<DiskBudget> {
  opts.onProgress?.("Running source disk preflight and bounded OCD garbage collection");
  await runDeploymentPreflightGc(opts.ip, opts.hostKey);
  const [free, context, current, rollback] = await Promise.all([
    availableBytes(opts.ip, opts.hostKey),
    sshExec(
      opts.ip,
      asUser(`du -sb ${JSON.stringify(opts.contextPath)} 2>/dev/null | awk '{print $1}'`),
      opts.hostKey,
    ).then((result) => Number(result.stdout.trim()) || 0),
    imageSize(opts.ip, `${opts.appName}:latest`, opts.hostKey),
    imageSize(opts.ip, `${opts.appName}:rollback`, opts.hostKey),
  ]);
  const budget = buildDiskBudget({
    availableBytes: free,
    contextBytes: context,
    currentImageBytes: current,
    rollbackImageBytes: rollback,
    registryBacked: opts.registryBacked,
  });
  assertDiskBudget("Source build", budget);
  opts.onProgress?.(
    `Source disk preflight passed: ${formatBytes(free)} free; ` +
      `${formatBytes(budget.requiredFreeBytes)} reserved for candidate/archive/safety`,
  );
  return budget;
}

export async function preflightTransferDiskSpace(opts: {
  ip: string;
  label: "source archive" | "destination import";
  imageBytes: number;
  archiveBytes: number;
  includeExpandedImage: boolean;
  protectedImageRefs?: string[];
  hostKey?: string;
  onProgress?: (line: string) => void;
}): Promise<DiskBudget> {
  opts.onProgress?.(`Running ${opts.label} disk preflight`);
  await runDeploymentPreflightGc(opts.ip, opts.hostKey);
  const [free, protectedSizes] = await Promise.all([
    availableBytes(opts.ip, opts.hostKey),
    Promise.all(
      (opts.protectedImageRefs ?? []).map((ref) => imageSize(opts.ip, ref, opts.hostKey)),
    ),
  ]);
  const budget = transferDiskBudget({
    availableBytes: free,
    imageBytes: opts.imageBytes,
    archiveBytes: opts.archiveBytes,
    includeExpandedImage: opts.includeExpandedImage,
    existingProtectedBytes: protectedSizes.reduce((sum, value) => sum + value, 0),
  });
  assertDiskBudget(opts.label === "source archive" ? "Source archive" : "Destination import", budget);
  opts.onProgress?.(
    `${opts.label} disk preflight passed: ${formatBytes(free)} free; ` +
      `${formatBytes(budget.requiredFreeBytes)} required`,
  );
  return budget;
}
