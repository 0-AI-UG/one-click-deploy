import { get } from "../api.ts";
import { table, colorStatus } from "../format.ts";

interface Service {
  id: number;
  name: string;
  service_type: string;
  status: string;
  linked_environments?: { id: number; name: string }[];
}

export async function services(): Promise<void> {
  const list = await get<Service[]>("/api/services");

  table(
    ["Name", "Type", "Status", "Injected Into"],
    list.map((s) => [
      s.name,
      s.service_type,
      colorStatus(s.status),
      s.linked_environments?.map((e) => e.name).join(", ") || "-",
    ]),
  );
}
