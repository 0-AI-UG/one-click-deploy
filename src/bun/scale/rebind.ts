import * as hetzner from "../hetzner/index.ts";

export async function rebindContainer(
  serverIpv4: string,
  app: any,
  bindAddr: string,
  hostPort: number,
  hostKey: string | undefined
): Promise<void> {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

  if (app.deploy_mode === "compose") {
    const overrideServices: any = {
      [app.compose_web_service]: {
        ports: [`${bindAddr}:${hostPort}:${app.container_port}`],
      },
    };
    const override = JSON.stringify({ services: overrideServices });
    const overridePath = `/home/deploy/apps/${app.name}/docker-compose.ocd.yml`;
    const escapedOverride = override.replace(/'/g, "'\\''");
    await hetzner.sshExec(serverIpv4, `echo '${escapedOverride}' > ${overridePath} && chown deploy:deploy ${overridePath}`, hostKey);
    await hetzner.sshExec(serverIpv4, asUser(`cd /home/deploy/apps/${app.name} && docker compose -p ${app.name} up -d`), hostKey);
  } else {
    const envVars = JSON.parse(app.env_vars || "{}");
    const envEntries = Object.entries(envVars);
    let envFileFlag = "";
    if (envEntries.length > 0) {
      envFileFlag = `--env-file /home/deploy/apps/${app.name}/.env.deploy`;
    }
    const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
    const tempName = `${app.name}-rebind`;
    const cmd = `docker run -d --name ${tempName} --restart unless-stopped -p ${bindAddr}:${hostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${app.name}:latest`;
    const startResult = await hetzner.sshExec(serverIpv4, asUser(cmd), hostKey);
    if (startResult.exitCode !== 0) {
      await hetzner.sshExec(serverIpv4, asUser(`docker rm -f ${tempName} 2>/dev/null || true`), hostKey);
      throw new Error(`Failed to restart container during scaling — check container logs for details`);
    }
    await hetzner.sshExec(serverIpv4, asUser(`docker rm -f ${app.name} 2>/dev/null || true`), hostKey);
    await hetzner.sshExec(serverIpv4, asUser(`docker rename ${tempName} ${app.name}`), hostKey);
  }
}
