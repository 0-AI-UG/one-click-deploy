import { get, appAddress } from "../api.ts";
import { table, colorStatus, BOLD, RESET, DIM } from "../format.ts";

interface DashboardApp {
  id: number;
  name: string;
  status: string;
  domain: string;
  public?: boolean | number;
  container_port?: number;
  internal_protocol?: string;
}

interface DashboardService {
  id: number;
  name: string;
  service_type: string;
  status: string;
}

interface Dashboard {
  apps: DashboardApp[];
  services: DashboardService[];
}

export async function status(): Promise<void> {
  const data = await get<Dashboard>("/api/dashboard");

  const running = data.apps.filter((a) => a.status === "running").length;
  const unhealthy = data.apps.filter((a) => a.status === "unhealthy").length;

  console.log(`${BOLD}Apps:${RESET} ${data.apps.length} total, ${running} running${unhealthy ? `, ${unhealthy} unhealthy` : ""}`);

  if (data.apps.length > 0) {
    table(
      ["Name", "Status", "Domain"],
      data.apps.map((a) => [a.name, colorStatus(a.status), appAddress(a)]),
    );
  }

  if (data.services.length > 0) {
    console.log();
    console.log(`${BOLD}Services:${RESET} ${data.services.length}`);
    table(
      ["Name", "Type", "Status"],
      data.services.map((s) => [s.name, s.service_type, colorStatus(s.status)]),
    );
  } else {
    console.log(`${DIM}No services${RESET}`);
  }
}
