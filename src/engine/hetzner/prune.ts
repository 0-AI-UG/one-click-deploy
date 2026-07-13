import { sshExec } from "./ssh.ts";
import { asUser, log, OCD_IMAGE_LABEL } from "./container-common.ts";

// `docker image prune -a` reclaims tagged-but-unreferenced images. A deploy's
// freshly built `${app}:latest` is unreferenced for the brief build-before-swap
// window (the old container still runs the previous image, the new container
// isn't started yet), so an unguarded prune that fires mid-deploy deletes the
// new image and the swap's `docker run` then fails "Unable to find image". The
// `until` filter only removes images created before now-minus-this-window, so
// anything built in the last few minutes is protected — far longer than the
// seconds-long swap gap, while genuinely stale images are still reclaimed.
// (Filters AND together, so this can only ever prune fewer images, never more.)
const PRUNE_MIN_IMAGE_AGE = "10m";

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
    // it (redeploy op drops the tag on success/compensation).
    `docker images ${appName} --format '{{.Repository}}:{{.Tag}}' | grep -vE ':(latest|rollback)$' | xargs -r docker rmi 2>/dev/null || true`,
    // Prune dangling images (untagged layers from previous builds). Scoped to
    // OCD-labeled layers so we never drop intermediate layers that belong to
    // other applications on this host.
    `docker image prune -f --filter label=${OCD_IMAGE_LABEL}`,
    // Compact the git repo
    `cd ${appDir} && git gc --auto 2>/dev/null || true`,
  ].join(" && ");

  sshExec(ip, asUser(cmd), hostKey).catch((err) => {
    log("prune", `Post-build cleanup on ${ip} failed (non-fatal): ${err}`);
  });
}

/**
 * Periodic disk cleanup. Two tiers based on disk pressure:
 *
 *   - Normal (root fs < 75% used): scoped prune. Removes unused OCD-labeled
 *     images, dangling images, foreign stopped containers, and ALL build
 *     cache (build cache is fully reproducible from sources).
 *
 *   - Pressure (root fs >= 75%): escalates to a full system prune. On an
 *     OCD-managed server there are essentially no non-OCD images worth
 *     preserving, and a crash from a full disk is far worse than a cold
 *     rebuild. Volumes are still preserved.
 *
 * NOTE: the container prune always excludes OCD-managed containers
 * (label!=ocd.managed=true). A sleeping app keeps its last container as a
 * *stopped* anchor so it can wake with a fast `docker start`; an unfiltered
 * `docker container prune` would delete that anchor, and once the container
 * is gone its image becomes unreferenced and gets swept by the image prune —
 * leaving the app unable to wake. OCD removes its own containers explicitly
 * (see scaleDown), so the blanket prune only needs to clear foreign junk.
 */
export async function pruneServer(ip: string, hostKey?: string) {
  // Probe disk usage on the root fs (where /var/lib/docker lives).
  const usage = await sshExec(ip, `df -P / | awk 'NR==2 {gsub("%",""); print $5}'`, hostKey);
  const usedPct = parseInt(usage.stdout.trim(), 10) || 0;
  const underPressure = usedPct >= 75;

  // Build the prune pipeline. Each step's output is trimmed to its summary
  // line so the log entry stays one line per server.
  const steps = underPressure
    ? [
        // Aggressive: anything not currently in use, plus all build cache.
        // Still preserve OCD-managed containers (sleeping anchors) so wake
        // stays fast and their images survive the image prune below.
        `docker container prune -f --filter "label!=${OCD_IMAGE_LABEL}" 2>&1 | tail -1`,
        `docker image prune -af --filter until=${PRUNE_MIN_IMAGE_AGE} 2>&1 | tail -1`,
        `docker builder prune -af 2>&1 | tail -1`,
      ]
    : [
        // Scoped: OCD-labeled images, dangling layers, foreign stopped
        // containers, and all build cache (always reproducible from sources).
        // Excludes OCD-managed containers so sleeping anchors are never swept.
        `docker container prune -f --filter "label!=${OCD_IMAGE_LABEL}" 2>&1 | tail -1`,
        `docker image prune -a -f --filter label=${OCD_IMAGE_LABEL} --filter until=${PRUNE_MIN_IMAGE_AGE} 2>&1 | tail -1`,
        `docker image prune -f 2>&1 | tail -1`,
        `docker builder prune -af 2>&1 | tail -1`,
      ];
  const result = await sshExec(ip, asUser(steps.join("; ")), hostKey);
  const tag = underPressure ? "prune(pressure)" : "prune";
  log(tag, `Server ${ip} (disk ${usedPct}%): ${result.stdout.trim().replace(/\n/g, " | ")}`);
}
