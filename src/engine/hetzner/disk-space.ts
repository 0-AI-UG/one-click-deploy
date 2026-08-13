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

/**
 * A host-side admission lease. The lease file is intentionally kept on the
 * Docker host (rather than only in panel memory) so concurrent panel workers
 * and a briefly restarted panel still observe the same claim. Leases older
 * than three hours are discarded on the next admission attempt.
 */
export type DiskReservation = {
  budget: DiskBudget;
  reservedBytes: number;
  replace: (futureBytes: number) => Promise<void>;
  refresh: () => Promise<void>;
  release: () => Promise<void>;
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
  // Estimate from build inputs, not from the image being replaced. Inheriting
  // a large current/rollback size creates a bootstrap trap: the deployment
  // intended to shrink that image is denied before Docker can prove it is
  // smaller. The 1 GiB floor, doubled context, host safety reserve, GC-first
  // admission and a durable per-host reservation coordinate the guarded build.
  const imageBytes = Math.max(
    GIB,
    input.contextBytes * 2,
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

const RESERVATION_DIR = "/tmp/ocd-disk-reservations";
const RESERVATION_LOCK = "/tmp/ocd-disk-admission.lock";
const RESERVATION_MAX_AGE_MINUTES = 180;
const BUILD_ADMISSION_LEASE = "/tmp/ocd-build-admission.lease";
const ADMISSION_RETRY_MS = 5_000;
const DISK_ADMISSION_WAIT_MS = 15 * 60_000;
const BUILD_ADMISSION_WAIT_MS = 2 * 60 * 60_000;

type AdmissionProgress = (line: string) => void;

function waitForAdmissionRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ADMISSION_RETRY_MS));
}

function reservationCommand(id: string, futureBytes: number, safetyBytes: number): string {
  return [
    `mkdir -p ${RESERVATION_DIR}`,
    `exec 9>${RESERVATION_LOCK}`,
    "flock -x 9",
    `find ${RESERVATION_DIR} -maxdepth 1 -type f -mmin +${RESERVATION_MAX_AGE_MINUTES} -delete 2>/dev/null || true`,
    `free=$(df -PB1 / | awk 'NR==2 {print $4}')`,
    "reserved=0",
    `for f in ${RESERVATION_DIR}/*; do [ -f \"$f\" ] || continue; [ \"$f\" = \"${RESERVATION_DIR}/${id}\" ] && continue; n=$(cat \"$f\" 2>/dev/null || echo 0); case \"$n\" in ''|*[!0-9]*) n=0;; esac; reserved=$((reserved+n)); done`,
    `needed=${Math.max(0, Math.ceil(futureBytes))}`,
    `safety=${Math.max(0, Math.ceil(safetyBytes))}`,
    `if [ \"$free\" -lt $((reserved+needed+safety)) ]; then printf 'OCD_DISK_DENIED %s %s %s %s\\n' \"$free\" \"$reserved\" \"$needed\" \"$safety\"; exit 42; fi`,
    `printf '%s\\n' \"$needed\" > ${RESERVATION_DIR}/.${id}.tmp`,
    `mv ${RESERVATION_DIR}/.${id}.tmp ${RESERVATION_DIR}/${id}`,
    `printf 'OCD_DISK_RESERVED %s %s %s\\n' \"$free\" \"$reserved\" \"$needed\"`,
  ].join("; ");
}

export function parseDiskAdmissionDenial(output: string): {
  freeBytes: number;
  otherReservedBytes: number;
  requestedBytes: number;
  safetyBytes: number;
} | null {
  const denied = output.match(/OCD_DISK_DENIED\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
  return denied ? {
    freeBytes: Number(denied[1]),
    otherReservedBytes: Number(denied[2]),
    requestedBytes: Number(denied[3]),
    safetyBytes: Number(denied[4]),
  } : null;
}

/** A non-zero competing claim makes a capacity denial transient. Once those
 * claims clear, the next atomic admission pass will either succeed or produce
 * a definitive physical-capacity failure with zero competing reservations. */
export function shouldWaitForDiskAdmission(
  denial: ReturnType<typeof parseDiskAdmissionDenial>,
): boolean {
  return !!denial && denial.otherReservedBytes > 0;
}

type BuildAdmissionLease = {
  refresh: () => Promise<void>;
  release: () => Promise<void>;
};

export function buildAdmissionLeaseCommand(id: string): string {
  return [
    `exec 9>${RESERVATION_LOCK}`,
    "flock -x 9",
    `find ${BUILD_ADMISSION_LEASE} -mmin +${RESERVATION_MAX_AGE_MINUTES} -delete 2>/dev/null || true`,
    `owner=$(cat ${BUILD_ADMISSION_LEASE} 2>/dev/null || true)`,
    `if [ -n "$owner" ] && [ "$owner" != "${id}" ]; then printf 'OCD_BUILD_BUSY %s\\n' "$owner"; exit 43; fi`,
    `printf '%s\\n' ${id} > ${BUILD_ADMISSION_LEASE}`,
    "printf 'OCD_BUILD_ADMITTED\\n'",
  ].join("; ");
}

/**
 * Acquire the host's durable guarded-build lease before measuring or
 * reserving disk. Tiny build contexts are deliberately poor upper bounds for
 * arbitrary Dockerfiles, so only one unknown source build may materialize on
 * a host at a time. The file lives on the host and is heartbeat-refreshed,
 * preserving coordination across panel workers and brief panel restarts.
 */
async function acquireBuildAdmission(
  ip: string,
  hostKey?: string,
  onProgress?: AdmissionProgress,
): Promise<BuildAdmissionLease> {
  const id = `b-${crypto.randomUUID().replace(/-/g, "")}`;
  const startedAt = Date.now();
  let lastProgressAt = 0;
  while (true) {
    const result = await sshExec(ip, buildAdmissionLeaseCommand(id), hostKey);
    if (result.exitCode === 0 && result.stdout.includes("OCD_BUILD_ADMITTED")) break;
    const busy = result.stdout.includes("OCD_BUILD_BUSY");
    const elapsedMs = Date.now() - startedAt;
    if (!busy || elapsedMs >= BUILD_ADMISSION_WAIT_MS) {
      if (busy) {
        throw new Error(
          `Source build admission timed out after ${Math.ceil(elapsedMs / 60_000)} minutes ` +
            `waiting for another guarded Docker build on ${ip}`,
        );
      }
      throw new Error(`Could not acquire source build admission on ${ip}`);
    }
    if (lastProgressAt === 0 || elapsedMs - lastProgressAt >= 30_000) {
      onProgress?.(
        `Waiting for another guarded Docker build on this server ` +
          `(${Math.floor(elapsedMs / 1000)}s elapsed)…`,
      );
      lastProgressAt = elapsedMs;
    }
    await waitForAdmissionRetry();
  }

  let released = false;
  let refreshInFlight: Promise<void> = Promise.resolve();
  const refresh = (): Promise<void> => {
    if (released) return Promise.resolve();
    refreshInFlight = refreshInFlight.then(async () => {
      if (released) return;
      // Only the current owner may refresh. A stale worker can therefore never
      // keep alive (or recreate) a lease acquired by a newer operation.
      const command = [
        `exec 9>${RESERVATION_LOCK}`,
        "flock -x 9",
        `owner=$(cat ${BUILD_ADMISSION_LEASE} 2>/dev/null || true)`,
        `[ "$owner" = "${id}" ] && touch ${BUILD_ADMISSION_LEASE} || true`,
      ].join("; ");
      await sshExec(ip, command, hostKey).then(() => undefined).catch(() => {
        /* next build admission remains fail-safe until stale-lease expiry */
      });
    });
    return refreshInFlight;
  };
  return {
    refresh,
    release: async () => {
      if (released) return;
      released = true;
      await refreshInFlight.catch(() => { /* heartbeat is best-effort */ });
      const command = [
        `exec 9>${RESERVATION_LOCK}`,
        "flock -x 9",
        `owner=$(cat ${BUILD_ADMISSION_LEASE} 2>/dev/null || true)`,
        `[ "$owner" != "${id}" ] || rm -f ${BUILD_ADMISSION_LEASE}`,
      ].join("; ");
      await sshExec(ip, command, hostKey).catch(() => {
        /* an unreachable host leaves a bounded stale lease, never a split lock */
      });
    },
  };
}

/** Atomically admit a disk-heavy phase against all other work on this host. */
async function reserveDisk(
  ip: string,
  label: string,
  budget: DiskBudget,
  hostKey?: string,
  onProgress?: AdmissionProgress,
): Promise<DiskReservation> {
  const id = `r-${crypto.randomUUID().replace(/-/g, "")}`;
  let reservedBytes = Math.max(0, budget.requiredFreeBytes - budget.safetyReserveBytes);

  const replace = async (futureBytes: number): Promise<void> => {
    const startedAt = Date.now();
    let lastProgressAt = 0;
    while (true) {
      const result = await sshExec(
        ip,
        reservationCommand(id, futureBytes, budget.safetyReserveBytes),
        hostKey,
      );
      const denied = parseDiskAdmissionDenial(result.stdout);
      if (result.exitCode === 0 && !denied) {
        reservedBytes = Math.max(0, Math.ceil(futureBytes));
        return;
      }
      const elapsedMs = Date.now() - startedAt;
      if (shouldWaitForDiskAdmission(denied) && elapsedMs < DISK_ADMISSION_WAIT_MS) {
        if (lastProgressAt === 0 || elapsedMs - lastProgressAt >= 30_000) {
          onProgress?.(
            `${label} is waiting for ${formatBytes(denied!.otherReservedBytes)} ` +
              `reserved by concurrent work (${Math.floor(elapsedMs / 1000)}s elapsed)…`,
          );
          lastProgressAt = elapsedMs;
        }
        await waitForAdmissionRetry();
        continue;
      }
      const free = denied?.freeBytes || 0;
      const other = denied?.otherReservedBytes || 0;
      const needed = denied?.requestedBytes || Math.max(0, futureBytes);
      const safety = denied?.safetyBytes || budget.safetyReserveBytes;
      const timeout = shouldWaitForDiskAdmission(denied)
        ? ` after waiting ${Math.ceil(elapsedMs / 60_000)} minutes`
        : "";
      throw new Error(
        `${label} disk admission failed${timeout}: ${formatBytes(free)} physically free, ` +
          `${formatBytes(other)} reserved by concurrent operations, ` +
          `${formatBytes(needed)} requested, and ${formatBytes(safety)} safety floor required`,
      );
    }
  };

  await replace(reservedBytes);
  let released = false;
  let refreshInFlight: Promise<void> = Promise.resolve();
  const refresh = (): Promise<void> => {
    if (released) return Promise.resolve();
    // Serialize heartbeats so release can drain every touch that was already
    // scheduled before deleting the lease. Without this, a late fire-and-
    // forget refresh could recreate the file just after release and leave a
    // false reservation until stale-lease expiry.
    refreshInFlight = refreshInFlight.then(async () => {
      if (released) return;
      await sshExec(ip, `touch ${RESERVATION_DIR}/${id}`, hostKey)
        .then(() => undefined)
        .catch(() => { /* next admission remains fail-safe */ });
    });
    return refreshInFlight;
  };
  return {
    budget,
    get reservedBytes() { return reservedBytes; },
    replace,
    refresh,
    release: async () => {
      if (released) return;
      released = true;
      await refreshInFlight.catch(() => { /* refresh is best-effort */ });
      await sshExec(ip, `rm -f ${RESERVATION_DIR}/${id}`, hostKey).catch(() => { /* stale lease expires */ });
    },
  };
}

/**
 * Operation-safe, bounded garbage collection. It removes only reconstructible
 * state: abandoned OCD transfer archives, stale OCD commit tags, dangling
 * OCD-labelled image data, and BuildKit cache older than one day.
 * Current/rollback tags and all container ancestors are never candidates. The
 * image-GC lock serializes this with builds/runs.
 */
export function buildDeploymentPreflightGcCommand(): string {
  return [
    // Work at exact image-ID granularity. Any metadata/container lookup error
    // skips that image, so transient Docker failures never become permission
    // to delete a protected image.
    `for id in $(docker image ls -q --no-trunc | sort -u); do ` +
      `meta=$(docker image inspect --format '{{index .Config.Labels "ocd.managed"}}|{{json .RepoTags}}' "$id" 2>/dev/null) || continue; ` +
      `managed=${"${meta%%|*}"}; refs=${"${meta#*|}"}; [ "$managed" = true ] || continue; ` +
      `printf '%s' "$refs" | grep -Eq ':((latest)|(rollback))"' && continue; ` +
      `containers=$(docker ps -aq --filter ancestor="$id" 2>/dev/null) || continue; ` +
      `[ -n "$containers" ] && continue; ` +
      `docker image rm "$id" >/dev/null 2>&1 || true; done`,
    `docker image prune -f --filter label=${OCD_IMAGE_LABEL} 2>/dev/null || true`,
    "docker builder prune -f --filter until=24h 2>/dev/null || true",
  ].join("; ");
}

export async function runDeploymentPreflightGc(ip: string, hostKey?: string): Promise<void> {
  await sshExec(
    ip,
    "find /tmp -maxdepth 1 -type f -name 'ocd-image-*.tar.gz' -mmin +180 -delete 2>/dev/null || true",
    hostKey,
  );
  await sshExec(ip, asUser(withExclusiveImageGc(buildDeploymentPreflightGcCommand())), hostKey);
}

export async function preflightBuildDiskSpace(opts: {
  ip: string;
  appName: string;
  contextPath: string;
  registryBacked: boolean;
  hostKey?: string;
  onProgress?: (line: string) => void;
}): Promise<DiskReservation> {
  opts.onProgress?.("Waiting for exclusive guarded-build admission on this server");
  const buildAdmission = await acquireBuildAdmission(opts.ip, opts.hostKey, opts.onProgress);
  try {
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
  // Atomic admission is authoritative. Unlike a standalone df assertion, it
  // can recognize concurrent reservations and wait for their temporary bytes
  // to clear before deciding whether physical capacity is truly insufficient.
  const reservation = await reserveDisk(
    opts.ip,
    "Source build",
    budget,
    opts.hostKey,
    opts.onProgress,
  );
  opts.onProgress?.(
    `Source disk preflight passed: ${formatBytes(free)} free; ` +
      `${formatBytes(budget.requiredFreeBytes)} reserved for candidate/archive/safety`,
  );
  return {
    budget: reservation.budget,
    get reservedBytes() { return reservation.reservedBytes; },
    replace: reservation.replace,
    refresh: async () => {
      await Promise.all([reservation.refresh(), buildAdmission.refresh()]);
    },
    release: async () => {
      try {
        await reservation.release();
      } finally {
        await buildAdmission.release();
      }
    },
  };
  } catch (error) {
    await buildAdmission.release();
    throw error;
  }
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
}): Promise<DiskReservation> {
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
  const label = opts.label === "source archive" ? "Source archive" : "Destination import";
  // Let atomic admission distinguish temporary reservation contention from a
  // definitive physical-capacity failure.
  const reservation = await reserveDisk(
    opts.ip,
    label,
    budget,
    opts.hostKey,
    opts.onProgress,
  );
  opts.onProgress?.(
    `${opts.label} disk preflight passed: ${formatBytes(free)} free; ` +
      `${formatBytes(budget.requiredFreeBytes)} required`,
  );
  return reservation;
}
