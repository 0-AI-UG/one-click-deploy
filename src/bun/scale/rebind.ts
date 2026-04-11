import { sshExec } from "../remote/index.ts";
import { type App } from "./types.ts";

export async function rebindContainer(
  serverIpv4: string,
  app: App,
  bindAddr: string,
  hostPort: number,
  hostKey: string | undefined
): Promise<void> {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

  if (app.deploy_mode === "compose") {
    const overrideServices: Record<string, { ports: string[] }> = {
      [app.compose_web_service]: {
        ports: [`${bindAddr}:${hostPort}:${app.container_port}`],
      },
    };
    const override = JSON.stringify({ services: overrideServices });
    const overridePath = `/home/deploy/apps/${app.name}/docker-compose.ocd.yml`;
    const escapedOverride = override.replace(/'/g, "'\\''");
    await sshExec(serverIpv4, `echo '${escapedOverride}' > ${overridePath} && chown deploy:deploy ${overridePath}`, hostKey);
    await sshExec(serverIpv4, asUser(`cd /home/deploy/apps/${app.name} && docker compose -p ${app.name} up -d`), hostKey);
  } else {
    const envVars = JSON.parse(app.env_vars || "{}");
    const envEntries = Object.entries(envVars);
    let envFileFlag = "";
    if (envEntries.length > 0) {
      envFileFlag = `--env-file /home/deploy/apps/${app.name}/.env.deploy`;
    }
    // Remove the old container first to free the host port. Docker won't let
    // two containers bind the same hostPort, so a temp-then-rename pattern
    // can't avoid downtime here — accept the sub-second gap and just swap.
    // No volume flag: scaleApp blocks volume-backed apps from crossing 1↔N.
    await sshExec(serverIpv4, asUser(`docker rm -f ${app.name} 2>/dev/null || true`), hostKey);
    const cmd = `docker run -d --name ${app.name} --restart unless-stopped -p ${bindAddr}:${hostPort}:${app.container_port} ${envFileFlag} ${app.name}:latest`;
    const startResult = await sshExec(serverIpv4, asUser(cmd), hostKey);
    if (startResult.exitCode !== 0) {
      throw new Error(`Failed to restart container during scaling — check container logs for details`);
    }
  }
}
