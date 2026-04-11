import { hetznerApi } from "./api.ts";
import { pollAction } from "./actions.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

type LBHttpConfig = {
  redirect_http: boolean;
  sticky_sessions: boolean;
  cookie_name?: string;
  cookie_lifetime?: number;
  certificates?: number[];
};

type LBService = {
  protocol: string;
  listen_port: number;
  destination_port: number;
  health_check: {
    protocol: string;
    port: number;
    interval: number;
    timeout: number;
    retries: number;
    http: {
      path: string;
      status_codes: string[];
    };
  };
  http: LBHttpConfig;
};

export type LoadBalancerTarget = {
  type: string;
  server?: { id: number };
};

export type LoadBalancer = {
  id: number;
  name: string;
  public_net: {
    ipv4: { ip: string };
    ipv6: { ip: string };
  };
  targets: LoadBalancerTarget[];
  services: LBService[];
};

type WithAction = { action?: { id: number } };
type WithLoadBalancer = { load_balancer: LoadBalancer };
type WithCertificate = { certificate: { id: number } };

export async function createLoadBalancer(
  appName: string,
  location: string
): Promise<{ id: number; ipv4: string }> {
  log("lb", `Creating load balancer for ${appName} in ${location}`);
  const data = await hetznerApi("/load_balancers", {
    method: "POST",
    body: JSON.stringify({
      name: `ocd-lb-${appName}`,
      load_balancer_type: "lb11",
      location,
      algorithm: { type: "least_connections" },
      labels: { managed_by: "one-click-deploy", app: appName },
    }),
  }) as unknown as WithLoadBalancer;
  const lb = data.load_balancer;
  log("lb", `Load balancer created: id=${lb.id} ipv4=${lb.public_net.ipv4.ip}`);
  return { id: lb.id, ipv4: lb.public_net.ipv4.ip };
}

export async function deleteLoadBalancer(lbId: string): Promise<void> {
  log("lb", `Deleting load balancer ${lbId}`);
  await hetznerApi(`/load_balancers/${lbId}`, { method: "DELETE" });
  log("lb", `Load balancer ${lbId} deleted`);
}

export async function addLBTarget(lbId: string, serverId: string): Promise<void> {
  log("lb", `Adding server ${serverId} to LB ${lbId}`);
  const data = await hetznerApi(`/load_balancers/${lbId}/actions/add_target`, {
    method: "POST",
    body: JSON.stringify({
      type: "server",
      server: { id: parseInt(serverId, 10) },
      use_private_net: false,
    }),
  }) as unknown as WithAction;
  if (data.action?.id) {
    await pollAction(data.action.id);
  }
  log("lb", `Server ${serverId} added to LB ${lbId}`);
}

export async function removeLBTarget(lbId: string, serverId: string): Promise<void> {
  log("lb", `Removing server ${serverId} from LB ${lbId}`);
  const data = await hetznerApi(`/load_balancers/${lbId}/actions/remove_target`, {
    method: "POST",
    body: JSON.stringify({
      type: "server",
      server: { id: parseInt(serverId, 10) },
    }),
  }) as unknown as WithAction;
  if (data.action?.id) {
    await pollAction(data.action.id);
  }
  log("lb", `Server ${serverId} removed from LB ${lbId}`);
}

export async function addLBService(
  lbId: string,
  destPort: number,
  certId?: number,
  stickySession?: boolean
): Promise<void> {
  log("lb", `Adding service to LB ${lbId}: destPort=${destPort} sticky=${stickySession} cert=${certId}`);

  // Use HTTPS if we have a certificate, otherwise use plain HTTP on port 80
  const useHttps = !!certId;
  const protocol = useHttps ? "https" : "http";
  const listenPort = useHttps ? 443 : 80;

  const httpConfig: LBHttpConfig = {
    redirect_http: useHttps,
    sticky_sessions: !!stickySession,
  };
  if (stickySession) {
    httpConfig.cookie_name = "HCLBSTICKY";
    httpConfig.cookie_lifetime = 86400; // max allowed: 86400 (24h)
  }
  if (useHttps) {
    httpConfig.certificates = [certId];
  }

  const service: LBService = {
    protocol,
    listen_port: listenPort,
    destination_port: destPort,
    health_check: {
      protocol: "http",
      port: destPort,
      interval: 15,
      timeout: 10,
      retries: 3,
      http: {
        path: "/",
        status_codes: ["2xx", "3xx", "4xx"],
      },
    },
    http: httpConfig,
  };
  const data = await hetznerApi(`/load_balancers/${lbId}/actions/add_service`, {
    method: "POST",
    body: JSON.stringify(service),
  }) as unknown as WithAction;
  if (data.action?.id) {
    await pollAction(data.action.id);
  }
  log("lb", `Service added to LB ${lbId} (${protocol}:${listenPort})`);
}

export async function createManagedCertificate(
  appName: string,
  domain: string
): Promise<{ id: number }> {
  const certName = `ocd-cert-${appName}`;
  log("lb", `Creating managed certificate for ${domain}`);
  try {
    const data = await hetznerApi("/certificates", {
      method: "POST",
      body: JSON.stringify({
        name: certName,
        type: "managed",
        domain_names: [domain],
      }),
    }) as unknown as WithCertificate;
    log("lb", `Certificate created: id=${data.certificate.id}`);
    return { id: data.certificate.id };
  } catch (err) {
    // Hetzner returns 409 ("certificate with exact set of domains already
    // exists" or "name already used") when a previous scale-up attempt
    // already created this cert. Look it up and reuse it instead of falling
    // through to a no-HTTPS LB. Without this, retried scale-ups silently
    // produce HTTP-only LBs and the domain becomes unreachable.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists") && !msg.includes("already used")) {
      throw err;
    }
    log("lb", `Certificate already exists, looking up by domain ${domain}`);
    const list = await hetznerApi(`/certificates`) as unknown as { certificates: Array<{ id: number; name: string; domain_names: string[] }> };
    const existing = (list.certificates ?? []).find(
      (c) => c.domain_names?.includes(domain) || c.name === certName,
    );
    if (!existing) {
      throw new Error(`Hetzner reported cert exists for ${domain} but lookup returned none`);
    }
    log("lb", `Reusing existing certificate id=${existing.id} (${existing.name})`);
    return { id: existing.id };
  }
}

export async function deleteCertificate(certId: string): Promise<void> {
  log("lb", `Deleting certificate ${certId}`);
  await hetznerApi(`/certificates/${certId}`, { method: "DELETE" });
  log("lb", `Certificate ${certId} deleted`);
}

export async function getLoadBalancer(lbId: string): Promise<LoadBalancer> {
  // Empty id would silently hit GET /load_balancers/ (the list endpoint),
  // returning { load_balancers: [...] } and producing a confusing
  // `undefined.public_net` crash downstream. Fail clearly instead.
  if (!lbId) throw new Error("getLoadBalancer called with empty id");
  const data = await hetznerApi(`/load_balancers/${lbId}`);
  return data.load_balancer as LoadBalancer;
}
