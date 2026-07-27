import { getApps, appAddress } from "../api.ts";
import { table, colorStatus } from "../format.ts";

export async function apps(): Promise<void> {
  const list = await getApps();

  table(
    ["Name", "Status", "Commit", "Domain", "Repo"],
    list.map((a) => [
      a.name,
      a.environment_stale
        ? `${colorStatus(a.status)} — stale environment, redeploy required`
        : colorStatus(a.status),
      a.deployed_commit ? a.deployed_commit.slice(0, 12) : "-",
      appAddress(a),
      a.git_repo ? a.git_repo.replace("https://github.com/", "") : "-",
    ]),
  );
}
