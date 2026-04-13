import { get } from "../api.ts";
import { table } from "../format.ts";

interface Server {
  id: number;
  name: string;
  ipv4: string;
  type: string;
  location: string;
  apps?: { id: number; name: string }[];
}

export async function servers(): Promise<void> {
  const list = await get<Server[]>("/api/servers");

  table(
    ["Name", "IP", "Type", "Location", "Apps"],
    list.map((s) => [
      s.name,
      s.ipv4,
      s.type,
      s.location,
      s.apps?.map((a) => a.name).join(", ") || "-",
    ]),
  );
}
