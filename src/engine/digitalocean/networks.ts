import { doApi } from "./api.ts";
import { getDroplet, privateIpv4 } from "./servers.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [do:${context}]`, ...args);
}

const VPC_NAME = "ocd-vpc";

type DoVpc = {
  id: string;
  name: string;
  region: string;
  ip_range: string;
  default: boolean;
};

/**
 * Ensure a VPC exists for the configured default region. DO VPCs are
 * region-scoped (unlike Hetzner's single multi-zone network), so we look up
 * (or create) one named `ocd-vpc` per region. The chosen region comes from
 * the `default_location` setting; if unset, we fall back to the project's
 * `default` VPC for `nyc3`.
 */
export async function ensureDoVpc(region?: string): Promise<{ id: string; region: string }> {
  const list = await doApi("/vpcs?per_page=200") as { vpcs: DoVpc[] };
  const region_ = region || (await defaultRegion(list.vpcs ?? []));
  const named = (list.vpcs ?? []).find((v) => v.name === VPC_NAME && v.region === region_);
  if (named) {
    log("vpc", `Using existing VPC: id=${named.id} region=${named.region}`);
    return { id: named.id, region: named.region };
  }
  // Fallback: reuse the region's default VPC if creation isn't allowed (some
  // accounts can't create extra VPCs). Otherwise, create our own.
  log("vpc", `Creating VPC ${VPC_NAME} in ${region_}`);
  try {
    const data = await doApi("/vpcs", {
      method: "POST",
      body: JSON.stringify({ name: VPC_NAME, region: region_ }),
    }) as { vpc: DoVpc };
    return { id: data.vpc.id, region: data.vpc.region };
  } catch (err) {
    const def = (list.vpcs ?? []).find((v) => v.region === region_ && v.default);
    if (def) {
      log("vpc", `VPC create failed, reusing default VPC ${def.id} for ${region_}: ${err}`);
      return { id: def.id, region: def.region };
    }
    throw err;
  }
}

async function defaultRegion(vpcs: DoVpc[]): Promise<string> {
  // Prefer the project's first default VPC region; otherwise nyc3.
  const def = vpcs.find((v) => v.default);
  return def?.region ?? "nyc3";
}

/** DO droplets get their VPC at create time, so attach is a no-op when the
 *  droplet was created with a vpc_uuid. We still verify the droplet is in the
 *  requested VPC; throw otherwise so the caller can recreate the droplet. */
export async function attachDropletToVpc(
  dropletId: string | number,
  vpcId: string,
): Promise<void> {
  const d = await getDroplet(dropletId);
  if (d.vpc_uuid === vpcId) {
    log("vpc", `Droplet ${dropletId} already in VPC ${vpcId}`);
    return;
  }
  if (!d.vpc_uuid) {
    throw new Error(
      `Droplet ${dropletId} has no VPC — DigitalOcean requires VPC assignment at create time. Recreate the droplet.`,
    );
  }
  throw new Error(
    `Droplet ${dropletId} is in VPC ${d.vpc_uuid}, expected ${vpcId}. DO does not support moving droplets between VPCs.`,
  );
}

export async function getDropletPrivateIp(dropletId: string | number): Promise<string> {
  const d = await getDroplet(dropletId);
  return privateIpv4(d);
}
