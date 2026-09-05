/** Maintenance helper: mark apps paused in OCD, then stop containers gracefully.
 * Resume by redeploying their stored desired configurations after cutover.
 */
import { get } from "../src/cli/api.ts";
for (const name of process.argv.slice(2)) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("Invalid app name");
  const app = (await get<Array<{ id: number; name: string }>>("/api/apps")).find(app => app.name === name);
  if (!app) throw new Error(`App not found: ${name}`);
  const pause = Bun.spawn(["ocd", "pause", name], { stdout: "ignore", stderr: "inherit" });
  if (await pause.exited) throw new Error(`Could not pause ${name}`);
  const replicas = await get<Array<{ container_name: string; server_id: number }>>(`/api/apps/${app.id}/replicas`);
  for (const replica of replicas) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(replica.container_name)) throw new Error("Invalid container name");
    const container = replica.container_name;
    const command = `docker unpause ${container} >/dev/null && docker stop --time 60 ${container} >/dev/null && test "$(docker inspect --format '{{.State.Running}}' ${container})" = false`;
    const stop = Bun.spawn(["ocd", "ssh", String(replica.server_id), "--server", command], { stdout: "ignore", stderr: "inherit" });
    if (await stop.exited) throw new Error(`Could not stop ${name} gracefully; inspect before cutover`);
  }
  console.log(`Quiesced ${name}`);
}
