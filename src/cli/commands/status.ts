import { get, appAddress } from "../api.ts";
import { table, colorStatus, BOLD, RESET } from "../format.ts";
import { expectArray, expectRecord } from "../response.ts";

interface DashboardApp {
  id: number;
  name: string;
  status: string;
  domain: string;
  public?: boolean | number;
  container_port?: number;
  internal_protocol?: string;
  deployed_commit?: string | null;
  environment_stale?: boolean | number;
}

interface Dashboard {
  apps: DashboardApp[];
}

export async function status(): Promise<void> {
  // The browser dashboard needs enriched app rows, including history
  // fields that can grow to several megabytes. Status needs only this compact
  // projection, so do not make a slow link download the web payload first.
  const payload = await get<unknown>("/api/dashboard?compact=1");
  const row = expectRecord(payload, "Status request");
  const apps = expectArray(row.apps, "Status apps") as DashboardApp[];
  for (const app of apps) {
    if (!app || typeof app.name !== "string" || typeof app.status !== "string") {
      throw new Error("Status request returned a malformed app entry");
    }
  }
  const data: Dashboard = { apps };

  const running = data.apps.filter((a) => a.status === "running").length;
  const unhealthy = data.apps.filter((a) => a.status === "unhealthy").length;

  console.log(`${BOLD}Apps:${RESET} ${data.apps.length} total, ${running} running${unhealthy ? `, ${unhealthy} unhealthy` : ""}`);

  if (data.apps.length > 0) {
    table(
      ["Name", "Status", "Commit", "Domain"],
      data.apps.map((a) => [
        a.name,
        a.environment_stale
          ? `${colorStatus(a.status)} — stale environment, redeploy required`
          : colorStatus(a.status),
        a.deployed_commit ? a.deployed_commit.slice(0, 12) : "-",
        appAddress(a),
      ]),
    );
  }
}
