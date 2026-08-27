import { sshExec, sshExecWithStdin } from "./ssh.ts";
import { asUser } from "./container-common.ts";

export type RegistryAuth = {
  /** Absolute path on the remote host to a DOCKER_CONFIG dir holding the ephemeral creds. */
  dockerConfig: string;
  /** Shell prefix to prepend to docker invocations so they pick up the ephemeral creds. */
  envPrefix: string;
  /** Best-effort cleanup of the credential dir. Always call in a `finally`. */
  cleanup: () => Promise<void>;
};

function registryHost(ref: string): string {
  return ref.replace(/^https?:\/\//, "").split("/")[0];
}

/** Authenticate to any OCI registry using an ephemeral Docker config. */
export async function dockerLoginRegistry(
  ip: string,
  registryRef: string,
  username: string,
  password: string,
  hostKey?: string,
): Promise<RegistryAuth> {
  const host = registryHost(registryRef);
  const rand = Math.random().toString(36).slice(2, 12);
  const dockerConfig = `/home/deploy/.docker-ocd-${rand}`;
  if (!/^[A-Za-z0-9._@+-]+$/.test(username)) {
    throw new Error("OCI registry username contains unsupported characters");
  }
  const result = await sshExecWithStdin(
    ip,
    asUser(
      `mkdir -p ${dockerConfig} && chmod 700 ${dockerConfig} && ` +
      `DOCKER_CONFIG=${dockerConfig} docker login ${host} -u ${username} --password-stdin`,
    ),
    password,
    hostKey,
  );
  if (result.exitCode !== 0) {
    await sshExec(ip, asUser(`rm -rf ${dockerConfig}`), hostKey).catch(() => {});
    throw new Error(`Failed to authenticate with OCI registry ${host}`);
  }
  return {
    dockerConfig,
    envPrefix: `DOCKER_CONFIG=${dockerConfig} `,
    cleanup: async () => {
      await sshExec(ip, asUser(`rm -rf ${dockerConfig}`), hostKey).catch(() => {});
    },
  };
}
