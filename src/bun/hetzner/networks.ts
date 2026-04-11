import { hetznerApi } from "./api.ts";
import { pollAction } from "./actions.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

const NETWORK_NAME = "ocd-net";
const NETWORK_IP_RANGE = "10.0.0.0/16";
const SUBNET_IP_RANGE = "10.0.0.0/24";
const NETWORK_ZONE = "eu-central";

type HetznerNetwork = {
  id: number;
  name: string;
  ip_range: string;
  subnets?: Array<{
    type: string;
    ip_range: string;
    network_zone: string;
  }>;
  servers?: number[];
};

type WithNetwork = { network: HetznerNetwork };
type WithAction = { action?: { id: number } };

/**
 * Ensure the shared `ocd-net` private network exists. Idempotent — returns
 * the network id whether it already existed or was just created. The network
 * has a single /24 subnet in the `eu-central` zone, which covers every
 * Hetzner Cloud location we use today (nbg1, fsn1, hel1). Additional zones
 * would need their own subnet via `add_subnet` — out of scope for now.
 */
export async function ensureNetwork(): Promise<{ id: number; ipRange: string }> {
  const list = (await hetznerApi(
    `/networks?name=${encodeURIComponent(NETWORK_NAME)}`,
  )) as unknown as { networks: HetznerNetwork[] };

  if (list.networks && list.networks.length > 0) {
    const net = list.networks[0];
    log("network", `Using existing network: id=${net.id} range=${net.ip_range}`);
    return { id: net.id, ipRange: net.ip_range };
  }

  log("network", `Creating private network ${NETWORK_NAME} (${NETWORK_IP_RANGE})...`);
  const data = (await hetznerApi("/networks", {
    method: "POST",
    body: JSON.stringify({
      name: NETWORK_NAME,
      ip_range: NETWORK_IP_RANGE,
      subnets: [
        {
          type: "cloud",
          ip_range: SUBNET_IP_RANGE,
          network_zone: NETWORK_ZONE,
        },
      ],
      labels: { managed_by: "one-click-deploy" },
    }),
  })) as unknown as WithNetwork;
  log("network", `Network created: id=${data.network.id}`);
  return { id: data.network.id, ipRange: data.network.ip_range };
}

export async function getNetwork(networkId: number): Promise<HetznerNetwork> {
  const data = (await hetznerApi(`/networks/${networkId}`)) as unknown as WithNetwork;
  return data.network;
}

/**
 * Attach a server to the private network. If the server is already attached,
 * this call returns a Hetzner `conflict` error (`server already attached`),
 * which we swallow so the reconciler pass is idempotent.
 */
export async function attachServerToNetwork(
  serverId: string | number,
  networkId: number,
): Promise<void> {
  log("network", `Attaching server ${serverId} to network ${networkId}`);
  try {
    const data = (await hetznerApi(
      `/servers/${serverId}/actions/attach_to_network`,
      {
        method: "POST",
        body: JSON.stringify({ network: networkId }),
      },
    )) as unknown as WithAction;
    if (data.action?.id) {
      await pollAction(data.action.id);
    }
    log("network", `Server ${serverId} attached to network ${networkId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Hetzner returns "server already attached to network" as a conflict —
    // treat it as success so callers can re-run the reconcile pass.
    if (/already attached/i.test(msg)) {
      log("network", `Server ${serverId} already attached to network ${networkId}`);
      return;
    }
    throw err;
  }
}

/**
 * Read the private IPv4 assigned to a server within `networkId`. The
 * server's `private_net` field is returned by the standard GET /servers/{id}
 * endpoint after attachment completes.
 */
export async function getPrivateIpv4(
  serverId: string | number,
  networkId: number,
): Promise<string> {
  const data = (await hetznerApi(`/servers/${serverId}`)) as unknown as {
    server: {
      private_net: Array<{ network: number; ip: string }>;
    };
  };
  const entry = (data.server.private_net ?? []).find(
    (n) => n.network === networkId,
  );
  return entry?.ip ?? "";
}
