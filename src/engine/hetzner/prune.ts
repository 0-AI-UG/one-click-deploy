import { sshExec } from "./ssh.ts";
import {
  asUser,
  log,
  OCD_IMAGE_PULL_MARKER_DIR,
  OCD_IMAGE_LABEL,
  OCD_RUNTIME_IMAGE_REPOSITORY,
  withExclusiveImageGc,
} from "./container-common.ts";

const JOURNALD_LIMITS = `[Journal]\nSystemMaxUse=500M\nSystemKeepFree=1G\nRuntimeMaxUse=100M\nMaxRetentionSec=7day\n`;

/** Converge bounded system-log retention on both new and existing hosts. */
export async function ensureHostLogPolicy(ip: string, hostKey?: string): Promise<void> {
  const encoded = Buffer.from(JOURNALD_LIMITS, "utf8").toString("base64");
  const command =
    `ocd_journal_tmp=/tmp/ocd-journald-policy-$$ && ` +
    `trap 'rm -f "$ocd_journal_tmp"' EXIT && ` +
    `printf '%s' '${encoded}' | base64 -d > "$ocd_journal_tmp" && ` +
    `mkdir -p /etc/systemd/journald.conf.d && ` +
    `(cmp -s "$ocd_journal_tmp" /etc/systemd/journald.conf.d/60-ocd-retention.conf || { ` +
    `install -m 0644 "$ocd_journal_tmp" /etc/systemd/journald.conf.d/60-ocd-retention.conf && ` +
    `systemctl restart systemd-journald && journalctl --vacuum-size=500M >/dev/null; }) && ` +
    `(command -v logrotate >/dev/null && logrotate --debug /etc/logrotate.conf >/dev/null 2>&1 || true)`;
  const result = await sshExec(ip, command, hostKey);
  if (result.exitCode !== 0) {
    throw new Error(`Could not converge host log retention on ${ip}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
}

// Never use `docker image prune -a` here. It removes tagged but currently
// unreferenced images, which includes the desired image during a container
// replacement and the last-known-good rollback image. Per-app cleanup below
// removes superseded commit tags explicitly; the periodic sweep only removes
// dangling layers.
/**
 * Periodic disk cleanup removes unused image data while preserving running,
 * stopped-anchor, current, and rollback images.
 *
 * NOTE: the container prune always excludes OCD-managed containers
 * (label!=ocd.managed=true). A sleeping app keeps its last container as a
 * *stopped* anchor so it can wake with a fast `docker start`; an unfiltered
 * `docker container prune` would delete that anchor, and once the container
 * is gone its image becomes unreferenced and gets swept by the image prune —
 * leaving the app unable to wake. OCD removes its own containers explicitly
 * (see scaleDown), so the blanket prune only needs to clear foreign junk.
 */
export type PruneServerOptions = {
  activeAppNames?: string[];
  /** Every DB-backed app/service/panel container on this server, including
   * sleeping stopped anchors. Managed stopped containers absent from this set
   * are interrupted-deploy or stale-placement debris and may be removed. */
  protectedContainerNames?: string[];
  /** The panel container whose GHCR repository should retain only the current
   * image plus one previous revision. Panel images are registry-built and do
   * not carry the ocd.managed label used by app image GC. */
  panelContainerName?: string;
  underPressure?: boolean;
};

export type GcImageCategory =
  | "running"
  | "stopped-anchor"
  | "current"
  | "rollback"
  | "reclaimable-ocd"
  | "reclaimable-foreign";

export type GcImageAsset = {
  category: GcImageCategory;
  id: string;
  size_bytes: number;
  refs: string[];
};

export type ServerGcInventory = {
  server_ip: string;
  images: GcImageAsset[];
  reclaimable_image_bytes: number;
  reclaimable_ocd_image_bytes: number;
  reclaimable_foreign_image_bytes: number;
  free_bytes_before: number;
  free_bytes_after: number;
  free_bytes_delta: number;
  reclaimed_bytes: number;
  removed_image_ids: string[];
  skipped_image_ids: string[];
  executed: boolean;
};

type GcRunOptions = {
  activeAppNames: string[];
  protectedImageRefs?: string[];
  activeOperationIds?: number[];
  buildCacheKeepStorage?: "1GB" | "4GB";
  execute: boolean;
};

/** Parse the decimal units emitted by `docker system df`. */
export function parseDockerSize(value: string): number | null {
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  const powers: Record<string, number> = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    kib: 1_024,
    mib: 1_024 ** 2,
    gib: 1_024 ** 3,
    tib: 1_024 ** 4,
  };
  return Math.round(amount * powers[unit]);
}

/**
 * Build one fail-closed host transaction. Docker's own metadata is treated as
 * authoritative: every image inspect must succeed, and execution revalidates
 * container ancestry plus current/rollback refs immediately before removal.
 * The exclusive OCD lock prevents deploy/build races for the whole inventory
 * and removal pass; Docker itself rejects removal of an externally-raced image.
 */
export function buildServerGcScript(opts: GcRunOptions): string {
  const activeNames = safeNames(opts.activeAppNames);
  const protectedImageRefs = safeImageRefs(opts.protectedImageRefs ?? []);
  const activeOperationIds = [...new Set(opts.activeOperationIds ?? [])];
  if (activeOperationIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Unsafe active operation ID in GC protection set");
  }
  const activeOperations = activeOperationIds.join(" ");
  const buildCacheKeepStorage = opts.buildCacheKeepStorage ?? "1GB";
  const activePattern = activeNames.length
    ? activeNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    : "ocd-no-active-app";
  const lines = [
    "set -eu",
    `active_pattern='${activePattern}'`,
    "free_before=$(df -B1 --output=avail / | tail -1 | tr -d ' ')",
    "running_images=''",
    "stopped_images=''",
    "protected_images=''",
    ...protectedImageRefs.map((ref) =>
      `if protected_id=$(docker image inspect --format '{{.Id}}' '${ref}' 2>/dev/null); then protected_images="$protected_images\n$protected_id"; fi`
    ),
    `for marker in ${OCD_IMAGE_PULL_MARKER_DIR}/*; do`,
    `  [ -f "$marker" ] || continue;`,
    `  find "$marker" -mmin -60 -print -quit | grep -q . || continue;`,
    `  digest=${"${marker##*/}"};`,
    `  for protected_id in $(docker images --filter "reference=${OCD_RUNTIME_IMAGE_REPOSITORY}/*:$digest" -q --no-trunc); do protected_images="$protected_images\n$protected_id"; done`,
    `done`,
    "running_containers=$(docker ps -q)",
    "all_containers=$(docker ps -aq)",
    "for cid in $all_containers; do",
    `  image=$(docker inspect --format '{{.Image}}' "$cid")`,
    `  if printf '%s\\n' "$running_containers" | grep -Fxq "$cid"; then running_images="$running_images\n$image"; else stopped_images="$stopped_images\n$image"; fi`,
    "done",
    "reclaimable_ids=''",
    "image_ids=$(docker image ls -aq --no-trunc | sort -u)",
    "for id in $image_ids; do",
    `  record=$(docker image inspect --format '{{.Id}}|{{.Size}}|{{json .RepoTags}}|{{if .Config.Labels}}{{index .Config.Labels "ocd.managed"}}{{end}}' "$id")`,
    `  actual_id=${"${record%%|*}"}; rest=${"${record#*|}"}; size=${"${rest%%|*}"}; rest=${"${rest#*|}"}; refs=${"${rest%%|*}"}; managed=${"${rest##*|}"}`,
    `  [ "$actual_id" = "$id" ] || { echo "Docker returned mismatched image metadata for $id" >&2; exit 42; }`,
    "  category=reclaimable-foreign",
    `  printf '%b\\n' "$running_images" | grep -Fxq "$id" && category=running`,
    `  if [ "$category" = reclaimable-foreign ] && printf '%b\\n' "$stopped_images" | grep -Fxq "$id"; then category=stopped-anchor; fi`,
    `  if [ "$category" = reclaimable-foreign ] && printf '%b\\n' "$protected_images" | grep -Fxq "$id"; then category=rollback; fi`,
    `  if [ "$category" = reclaimable-foreign ] && printf '%s' "$refs" | grep -Eq "\\\"($active_pattern):latest\\\""; then category=current; fi`,
    `  if [ "$category" = reclaimable-foreign ] && printf '%s' "$refs" | grep -Eq "\\\"($active_pattern):rollback\\\""; then category=rollback; fi`,
    `  if [ "$category" = reclaimable-foreign ] && [ "$managed" = true ]; then category=reclaimable-ocd; fi`,
    `  printf 'OCD_GC\\t%s\\t%s\\t%s\\t%s\\n' "$category" "$id" "$size" "$refs"`,
    `  case "$category" in reclaimable-ocd|reclaimable-foreign) reclaimable_ids="$reclaimable_ids $id" ;; esac`,
    "done",
  ];
  if (opts.execute) {
    lines.push(
      "for id in $reclaimable_ids; do",
      // Recheck all container states, not only running containers. No force is
      // used, so Docker remains the final safety barrier for external races.
      `  if docker ps -aq --filter ancestor="$id" | grep -q .; then printf 'OCD_SKIPPED\\t%s\\n' "$id"; continue; fi`,
      `  refs=$(docker image inspect --format '{{json .RepoTags}}' "$id" 2>/dev/null) || { printf 'OCD_SKIPPED\\t%s\\n' "$id"; continue; }`,
      `  if printf '%b\\n' "$protected_images" | grep -Fxq "$id"; then printf 'OCD_SKIPPED\\t%s\\n' "$id"; continue; fi`,
      `  if printf '%s' "$refs" | grep -Eq "\\\"($active_pattern):(latest|rollback)\\\""; then printf 'OCD_SKIPPED\\t%s\\n' "$id"; continue; fi`,
      `  tag_list=$(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "$id" 2>/dev/null) || { printf 'OCD_SKIPPED\\t%s\\n' "$id"; continue; }`,
      `  removal_ok=true; for ref in $tag_list; do docker image rm "$ref" >/dev/null 2>&1 || removal_ok=false; done`,
      `  docker image rm "$id" >/dev/null 2>&1 || { docker image inspect "$id" >/dev/null 2>&1 && removal_ok=false || true; }`,
      `  if [ "$removal_ok" = true ]; then printf 'OCD_REMOVED\\t%s\\n' "$id"; else printf 'OCD_SKIPPED\\t%s\\n' "$id"; fi`,
      "done",
      `find ${OCD_IMAGE_PULL_MARKER_DIR} -xdev -type f -mmin +60 -delete 2>/dev/null || true`,
      `find /home/deploy/apps -xdev -mindepth 2 -maxdepth 2 -type d -name .git -prune -exec rm -rf {} + 2>/dev/null || true`,
      `active_operations=' ${activeOperations} '`,
      `for dir in /home/deploy/apps/*/.ocd-revision-snapshot-*; do`,
      `  [ -d "$dir" ] || continue; op_id=${"${dir##*-}"};`,
      `  case "$op_id" in ''|*[!0-9]*) continue ;; esac;`,
      `  case "$active_operations" in *" $op_id "*) ;; *) rm -rf "$dir" ;; esac`,
      `done`,
      `docker builder prune -af --keep-storage ${buildCacheKeepStorage} >/dev/null 2>&1 || true`,
      `for builder in $(docker buildx ls --format '{{.Name}}' 2>/dev/null | sort -u); do`,
      `  docker buildx inspect "$builder" >/dev/null 2>&1 || continue;`,
      `  docker buildx prune --builder "$builder" -af --keep-storage ${buildCacheKeepStorage} >/dev/null 2>&1 || true`,
      `done`,
    );
  }
  lines.push(
    "free_after=$(df -B1 --output=avail / | tail -1 | tr -d ' ')",
    `printf 'OCD_SPACE\\t%s\\t%s\\n' "$free_before" "$free_after"`,
  );
  return lines.join("\n");
}

async function runServerGc(ip: string, hostKey: string | undefined, opts: GcRunOptions): Promise<ServerGcInventory> {
  const result = await sshExec(ip, asUser(withExclusiveImageGc(buildServerGcScript(opts))), hostKey);
  if (result.exitCode !== 0) {
    const action = opts.execute ? "Garbage collection" : "Docker storage inventory";
    throw new Error(`${action} failed on ${ip}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  const images: GcImageAsset[] = [];
  const removedImageIds: string[] = [];
  const skippedImageIds: string[] = [];
  let freeBefore = 0;
  let freeAfter = 0;
  let sawSpace = false;
  const categories = new Set<GcImageCategory>([
    "running", "stopped-anchor", "current", "rollback", "reclaimable-ocd", "reclaimable-foreign",
  ]);
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("OCD_GC\t")) {
      const [, category, id, sizeRaw, refsRaw] = line.split("\t", 5);
      if (!categories.has(category as GcImageCategory) || !/^sha256:[0-9a-f]{64}$/.test(id) || !/^\d+$/.test(sizeRaw)) {
        throw new Error(`Docker returned malformed image metadata on ${ip}`);
      }
      let refs: string[] = [];
      try {
        const parsed = JSON.parse(refsRaw || "[]");
        if (parsed === null) refs = [];
        else if (Array.isArray(parsed) && parsed.every((ref) => typeof ref === "string")) refs = parsed;
        else throw new Error("invalid RepoTags");
      } catch {
        throw new Error(`Docker returned malformed image metadata on ${ip}`);
      }
      images.push({ category: category as GcImageCategory, id, size_bytes: Math.max(0, Number(sizeRaw) || 0), refs });
    } else if (line.startsWith("OCD_REMOVED\t")) {
      removedImageIds.push(line.slice("OCD_REMOVED\t".length).trim());
    } else if (line.startsWith("OCD_SKIPPED\t")) {
      skippedImageIds.push(line.slice("OCD_SKIPPED\t".length).trim());
    } else if (line.startsWith("OCD_SPACE\t")) {
      const [, beforeRaw, afterRaw] = line.split("\t", 3);
      freeBefore = Math.max(0, Number(beforeRaw) || 0);
      freeAfter = Math.max(0, Number(afterRaw) || 0);
      sawSpace = /^\d+$/.test(beforeRaw) && /^\d+$/.test(afterRaw);
    }
  }
  if (!sawSpace) throw new Error(`Docker storage inventory on ${ip} returned an incomplete response`);
  const isReclaimable = (image: GcImageAsset) => image.category.startsWith("reclaimable-");
  const reclaimableOcd = images.filter((image) => image.category === "reclaimable-ocd").reduce((sum, image) => sum + image.size_bytes, 0);
  const reclaimableForeign = images.filter((image) => image.category === "reclaimable-foreign").reduce((sum, image) => sum + image.size_bytes, 0);
  const freeDelta = freeAfter - freeBefore;
  if (opts.execute) {
    const accounted = new Set([...removedImageIds, ...skippedImageIds]);
    const unaccounted = images.filter(isReclaimable).find((image) => !accounted.has(image.id));
    if (unaccounted) throw new Error(`Garbage collection on ${ip} did not account for image ${unaccounted.id}`);
  }
  return {
    server_ip: ip,
    images,
    reclaimable_image_bytes: images.filter(isReclaimable).reduce((sum, image) => sum + image.size_bytes, 0),
    reclaimable_ocd_image_bytes: reclaimableOcd,
    reclaimable_foreign_image_bytes: reclaimableForeign,
    free_bytes_before: freeBefore,
    free_bytes_after: freeAfter,
    free_bytes_delta: freeDelta,
    reclaimed_bytes: Math.max(0, freeDelta),
    removed_image_ids: removedImageIds,
    skipped_image_ids: skippedImageIds,
    executed: opts.execute,
  };
}

/**
 * Inventory images by protection reason using exact IDs. Shared layers mean
 * image sizes are not additive; `reclaimable_image_bytes` is therefore an
 * upper bound and the response states that caveat at the CLI boundary.
 */
export async function inspectServerGc(
  ip: string,
  hostKey?: string,
  opts: { activeAppNames?: string[]; protectedImageRefs?: string[]; activeOperationIds?: number[] } = {},
): Promise<ServerGcInventory> {
  return runServerGc(ip, hostKey, {
    activeAppNames: opts.activeAppNames ?? [],
    protectedImageRefs: opts.protectedImageRefs,
    activeOperationIds: opts.activeOperationIds,
    execute: false,
  });
}

/** Remove every inventory-proven unused image (OCD and foreign/unlabelled),
 * equivalent to Docker's `image prune -a` eligibility, while retaining every
 * container ancestor and OCD current/rollback asset; then trim build cache. */
export async function garbageCollectServer(
  ip: string,
  hostKey?: string,
  opts: {
    activeAppNames?: string[];
    protectedImageRefs?: string[];
    activeOperationIds?: number[];
    buildCacheKeepStorage?: "1GB" | "4GB";
  } = {},
): Promise<ServerGcInventory> {
  return runServerGc(ip, hostKey, {
    activeAppNames: opts.activeAppNames ?? [],
    protectedImageRefs: opts.protectedImageRefs,
    activeOperationIds: opts.activeOperationIds,
    buildCacheKeepStorage: opts.buildCacheKeepStorage,
    execute: true,
  });
}

function safeNames(names: string[]): string[] {
  const unique = [...new Set(names)];
  const unsafe = unique.find((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name));
  if (unsafe) {
    // Silently dropping a DB-backed protection name would turn malformed
    // state into authorization to delete its stopped container. Fail closed:
    // maintenance can retry after the bad row is repaired.
    throw new Error(`Unsafe Docker name in prune protection set: ${JSON.stringify(unsafe)}`);
  }
  return unique;
}

function safeImageRefs(refs: string[]): string[] {
  const unique = [...new Set(refs.filter(Boolean))];
  const unsafe = unique.find((ref) => !/^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]*$/.test(ref));
  if (unsafe) throw new Error(`Unsafe Docker image reference in GC protection set: ${JSON.stringify(unsafe)}`);
  return unique;
}

export function buildServerPruneSteps(opts: PruneServerOptions = {}): string[] {
  const activeAppNames = safeNames(opts.activeAppNames ?? []);
  const protectedContainerNames = safeNames(opts.protectedContainerNames ?? []);
  const protectedContainers = protectedContainerNames.join("|");
  const steps: string[] = [
    // OCD-managed stopped containers are normally sleeping anchors, but an
    // interrupted scale/deploy can leave a created/exited container after its
    // replica row is gone. Remove only non-running containers absent from the
    // complete DB-backed protection set; never kill an untracked running one.
    `for name in $(docker ps -a --filter label=${OCD_IMAGE_LABEL} --format '{{.Names}}'); do ` +
      `state=$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || true); ` +
      `case "$state" in created|exited|dead) ` +
      (protectedContainers
        ? `case "$name" in ${protectedContainers}) ;; *) docker container rm -f "$name" >/dev/null 2>&1 || true ;; esac`
        : `docker container rm -f "$name" >/dev/null 2>&1 || true`) +
      ` ;; esac; done`,
    // Current OCD versions tag every pulled immutable digest locally. Remove
    // only those owned tags when no running or stopped container uses the
    // image; operator-owned images remain outside this namespace.
    `for ref in $(docker images --filter 'reference=${OCD_RUNTIME_IMAGE_REPOSITORY}/*:*' --format '{{.Repository}}:{{.Tag}}'); do ` +
      `id=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true); ` +
      `[ -z "$id" ] && continue; ` +
      `digest=${"${ref##*:}"}; marker=${OCD_IMAGE_PULL_MARKER_DIR}/$digest; ` +
      `if [ -f "$marker" ] && find "$marker" -mmin -60 -print -quit | grep -q .; then continue; fi; ` +
      `if ! docker ps -aq --filter ancestor="$id" | grep -q .; then ` +
      `docker image rm "$ref" >/dev/null 2>&1 && rm -f "$marker" || true; fi; done; ` +
      `find ${OCD_IMAGE_PULL_MARKER_DIR} -xdev -type f -mmin +60 -delete 2>/dev/null || true`,
  ];

  if (activeAppNames.length > 0) {
    const active = activeAppNames.join("|");
    steps.push(
      `for ref in $(docker images --filter label=${OCD_IMAGE_LABEL} --format '{{.Repository}}:{{.Tag}}'); do ` +
        `repo=${"${ref%:*}"}; tag=${"${ref##*:}"}; ` +
        `case "$repo" in ${active}) ` +
        `case "$tag" in latest|rollback) ;; *) ` +
        `docker ps -aq --filter ancestor="$ref" | grep -q . || docker image rm "$ref" >/dev/null 2>&1 || true ;; esac ` +
        `;; *) docker image rm "$ref" >/dev/null 2>&1 || true ;; esac; done`,
    );
  } else {
    steps.push(
      `docker images --filter label=${OCD_IMAGE_LABEL} --format '{{.Repository}}:{{.Tag}}' | ` +
        `xargs -r docker image rm >/dev/null 2>&1 || true`,
    );
  }

  const panelContainerName = safeNames(opts.panelContainerName ? [opts.panelContainerName] : [])[0];
  if (panelContainerName) {
    steps.push(
      `current_ref=$(docker inspect --format '{{.Config.Image}}' ${panelContainerName} 2>/dev/null || true); ` +
        `repo=${"${current_ref%:*}"}; previous_kept=0; ` +
        `if [ -n "$current_ref" ] && [ "$repo" != "$current_ref" ]; then ` +
        `docker images "$repo" --format '{{.Repository}}:{{.Tag}}' | while read -r ref; do ` +
        `[ -z "$ref" ] && continue; [ "$ref" = "$current_ref" ] && continue; ` +
        `if docker ps -aq --filter ancestor="$ref" | grep -q .; then continue; fi; ` +
        `if [ "$previous_kept" = "0" ]; then previous_kept=1; continue; fi; ` +
        `docker image rm "$ref" >/dev/null 2>&1 || true; done; fi`,
    );
  }

  // Maintenance must not run Docker-wide prune commands. A digest-only image
  // is briefly unreferenced between `docker pull` and `docker run`, so even
  // `docker image prune -f` can race a release and delete its candidate.
  // Likewise, `label!=ocd.managed=true` includes operator-owned stopped
  // containers (and removed the pre-upgrade panel rollback container in
  // production). The targeted loops above own only known OCD resources;
  // broader cleanup remains an explicit, inventoried `ocd gc --execute`.
  return steps;
}

export async function pruneServer(ip: string, hostKey?: string, opts: PruneServerOptions = {}) {
  // Probe disk usage on the root fs (where /var/lib/docker lives).
  const usage = await sshExec(ip, `df -P / | awk 'NR==2 {gsub("%",""); print $5}'`, hostKey);
  const usedPct = parseInt(usage.stdout.trim(), 10) || 0;
  const underPressure = usedPct >= 75;

  const steps = buildServerPruneSteps({ ...opts, underPressure });
  const result = await sshExec(ip, asUser(withExclusiveImageGc(steps.join("; "))), hostKey);
  const tag = underPressure ? "prune(pressure)" : "prune";
  log(tag, `Server ${ip} (disk ${usedPct}%): ${result.stdout.trim().replace(/\n/g, " | ")}`);
}
