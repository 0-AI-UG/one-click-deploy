import { sshExec } from "./ssh.ts";
import { asUser, log, OCD_IMAGE_LABEL, withExclusiveImageGc } from "./container-common.ts";
import { runDeploymentPreflightGc } from "./disk-space.ts";

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
 * Prune dangling Docker images and trim the git repo after a successful build.
 * Runs in the background (fire-and-forget) so it doesn't slow down deploys.
 */
export function pruneAfterBuild(ip: string, appName: string, hostKey?: string) {
  const appDir = `/home/deploy/apps/${appName}`;

  // Remove old commit-tagged images for this app (keep only :latest which the
  // running container uses), prune dangling images, and compact the git repo.
  const cmd = [
    // Remove all tags for this app except :latest and :rollback — old commit
    // tags are no longer needed since rollback rebuilds from git. The
    // `:rollback` tag pins the previous image so a failed redeploy can restore
    // it. The next redeploy atomically replaces this tag with the then-current
    // image, so exactly one rollback image remains pinned.
    `docker images ${appName} --format '{{.Repository}}:{{.Tag}}' | grep -vE ':(latest|rollback)$' | xargs -r docker rmi 2>/dev/null || true`,
    // Prune dangling images (untagged layers from previous builds). Scoped to
    // OCD-labeled layers so we never drop intermediate layers that belong to
    // other applications on this host.
    `docker image prune -f --filter label=${OCD_IMAGE_LABEL}`,
    // Compact the git repo
    `cd ${appDir} && git gc --auto 2>/dev/null || true`,
  ].join(" && ");

  sshExec(ip, asUser(withExclusiveImageGc(cmd)), hostKey).catch((err) => {
    log("prune", `Post-build cleanup on ${ip} failed (non-fatal): ${err}`);
  });
}

/**
 * Periodic disk cleanup. Two tiers based on disk pressure:
 *
 *   - Normal (root fs < 75% used): removes dangling images, foreign stopped
 *     containers, and ALL build cache (build cache is reproducible).
 *
 *   - Pressure (root fs >= 75%): also prunes all dangling layers, but still
 *     preserves tagged current, desired, and rollback images. Operators get
 *     disk-pressure visibility without GC invalidating a deployment revision.
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
};

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
  ];

  if (activeAppNames.length > 0) {
    const keep = activeAppNames.map((name) => `${name}:*`).join("|");
    steps.push(
      `for ref in $(docker images --filter label=${OCD_IMAGE_LABEL} --format '{{.Repository}}:{{.Tag}}'); do ` +
        `case "$ref" in ${keep}) ;; *) docker image rm "$ref" >/dev/null 2>&1 || true ;; esac; done`,
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

  steps.push(
    `docker container prune -f --filter "label!=${OCD_IMAGE_LABEL}" 2>&1 | tail -1`,
    `docker image prune -f 2>&1 | tail -1`,
    `docker builder prune -af 2>&1 | tail -1`,
  );
  return steps;
}

export async function pruneServer(ip: string, hostKey?: string, opts: PruneServerOptions = {}) {
  // Clear abandoned operation archives and old reconstructible builder state
  // before the ordinary pressure-based pass below.
  await runDeploymentPreflightGc(ip, hostKey);
  // Probe disk usage on the root fs (where /var/lib/docker lives).
  const usage = await sshExec(ip, `df -P / | awk 'NR==2 {gsub("%",""); print $5}'`, hostKey);
  const usedPct = parseInt(usage.stdout.trim(), 10) || 0;
  const underPressure = usedPct >= 75;

  const steps = buildServerPruneSteps(opts);
  const result = await sshExec(ip, asUser(withExclusiveImageGc(steps.join("; "))), hostKey);
  const tag = underPressure ? "prune(pressure)" : "prune";
  log(tag, `Server ${ip} (disk ${usedPct}%): ${result.stdout.trim().replace(/\n/g, " | ")}`);
}
