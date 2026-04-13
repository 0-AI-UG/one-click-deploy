import { getApps } from "../api.ts";
import { table, colorStatus } from "../format.ts";

export async function apps(): Promise<void> {
  const list = await getApps();

  table(
    ["Name", "Status", "Domain", "Repo"],
    list.map((a) => [
      a.name,
      colorStatus(a.status),
      a.domain || "-",
      a.git_repo ? a.git_repo.replace("https://github.com/", "") : "-",
    ]),
  );
}
