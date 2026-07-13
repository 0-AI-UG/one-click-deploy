import { sshExec } from "./ssh.ts";
import { asUser, log } from "./container-common.ts";

export type GhcrAuth = {
  /** Absolute path on the remote host to a DOCKER_CONFIG dir holding the ephemeral creds. */
  dockerConfig: string;
  /** Shell prefix to prepend to docker invocations so they pick up the ephemeral creds. */
  envPrefix: string;
  /** Best-effort cleanup of the credential dir. Always call in a `finally`. */
  cleanup: () => Promise<void>;
};

/**
 * Authenticate against ghcr.io into a *per-deploy* DOCKER_CONFIG dir instead
 * of the user's persistent `~/.docker/config.json`. The returned `envPrefix`
 * must be prepended to subsequent `docker pull` / `docker build` invocations
 * that need the credentials; `cleanup()` removes the
 * config dir so the token never outlives the deploy.
 */
export async function dockerLoginGhcr(
  ip: string,
  token: string,
  hostKey?: string,
): Promise<GhcrAuth> {
  // Random per-deploy dir, owned by `deploy` user (the uid that runs docker).
  const rand = Math.random().toString(36).slice(2, 12);
  const dockerConfig = `/home/deploy/.docker-ocd-${rand}`;
  const escaped = token.replace(/'/g, "'\\''");
  const result = await sshExec(
    ip,
    asUser(
      `mkdir -p ${dockerConfig} && chmod 700 ${dockerConfig} && ` +
      `DOCKER_CONFIG=${dockerConfig} sh -c "echo '${escaped}' | docker login ghcr.io -u x-access-token --password-stdin"`,
    ),
    hostKey,
  );
  if (result.exitCode !== 0) {
    log("registry", `ghcr.io login failed: ${result.stderr}`);
    // Best-effort: nuke the dir even on failure so a half-written config
    // doesn't linger.
    await sshExec(ip, asUser(`rm -rf ${dockerConfig}`), hostKey).catch(() => {});
    throw new Error(
      "Failed to authenticate with GitHub Container Registry (ghcr.io). Check your GitHub token has the read:packages scope.",
    );
  }
  log("registry", "ghcr.io login succeeded (ephemeral DOCKER_CONFIG)");
  return {
    dockerConfig,
    envPrefix: `DOCKER_CONFIG=${dockerConfig} `,
    cleanup: async () => {
      const r = await sshExec(ip, asUser(`rm -rf ${dockerConfig}`), hostKey).catch((err) => {
        log("registry", `ghcr cleanup failed (non-fatal): ${err}`);
        return null;
      });
      if (r && r.exitCode !== 0) {
        log("registry", `ghcr cleanup non-zero exit: ${r.stderr}`);
      }
    },
  };
}
