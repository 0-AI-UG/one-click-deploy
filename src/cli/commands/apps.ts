import { getApps, appAddress } from "../api.ts";
import { table, colorStatus } from "../format.ts";

export async function apps(): Promise<void> {
  const list = await getApps();

  table(
    ["Name", "Status", "Image", "Domain"],
    list.map((a) => [
      a.name,
      a.environment_stale
        ? `${colorStatus(a.status)} — stale environment, redeploy required`
        : colorStatus(a.status),
      a.image_ref ? a.image_ref.split("@sha256:").pop()?.slice(0, 12) || "-" : "-",
      appAddress(a),
    ]),
  );
}
