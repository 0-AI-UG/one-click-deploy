import { sshExec } from "./ssh.ts";
import { asUser, log, OCD_IMAGE_LABEL, withExclusiveImageGc } from "./container-common.ts";

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
export async function pruneServer(ip: string, hostKey?: string) {
  // Probe disk usage on the root fs (where /var/lib/docker lives).
  const usage = await sshExec(ip, `df -P / | awk 'NR==2 {gsub("%",""); print $5}'`, hostKey);
  const usedPct = parseInt(usage.stdout.trim(), 10) || 0;
  const underPressure = usedPct >= 75;

  // Build the prune pipeline. Each step's output is trimmed to its summary
  // line so the log entry stays one line per server.
  const steps = underPressure
    ? [
        // Preserve all tagged revision images even under pressure. Per-app
        // post-build cleanup bounds old OCD tags.
        `docker container prune -f --filter "label!=${OCD_IMAGE_LABEL}" 2>&1 | tail -1`,
        `docker image prune -f 2>&1 | tail -1`,
        `docker builder prune -af 2>&1 | tail -1`,
      ]
    : [
        // Dangling layers, foreign stopped containers, and all build cache.
        // Excludes OCD-managed containers so sleeping anchors are never swept.
        `docker container prune -f --filter "label!=${OCD_IMAGE_LABEL}" 2>&1 | tail -1`,
        `docker image prune -f 2>&1 | tail -1`,
        `docker builder prune -af 2>&1 | tail -1`,
      ];
  const result = await sshExec(ip, asUser(withExclusiveImageGc(steps.join("; "))), hostKey);
  const tag = underPressure ? "prune(pressure)" : "prune";
  log(tag, `Server ${ip} (disk ${usedPct}%): ${result.stdout.trim().replace(/\n/g, " | ")}`);
}
