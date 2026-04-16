import db from "./connection.ts";

export type ServiceRow = {
  id: number;
  org_id: string;
  name: string;
  service_type: string;
  version: string;
  status: string;
  port: number;
  env_vars: string;
  credentials: string;
  desired_instances: number;
  created_at: string;
};

export type ServiceInstanceRow = {
  id: number;
  service_id: number;
  server_id: number;
  role: string;
  container_name: string;
  host_port: number;
  volume_id: string;
  volume_mount: string;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  unhealthy_ticks: number;
  last_health_at: string | null;
  created_at: string;
};

export type ServiceLinkRow = {
  id: number;
  service_id: number;
  app_id: number;
  env_prefix: string;
  created_at: string;
};

export type ServiceLinkWithAppRow = ServiceLinkRow & { app_name: string };
export type ServiceLinkWithServiceRow = ServiceLinkRow & { service_name: string; service_type: string; credentials: string };

export function insertService(data: {
  name: string;
  service_type: string;
  version: string;
  port: number;
  env_vars: string;
  credentials: string;
  desired_instances?: number;
  org_id: string;
}): ServiceRow {
  return db
    .query(
      "INSERT INTO services (name, service_type, version, port, env_vars, credentials, desired_instances, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(data.name, data.service_type, data.version, data.port, data.env_vars, data.credentials, data.desired_instances ?? 1, data.org_id) as ServiceRow;
}

export function getService(id: number): ServiceRow | null {
  return db.query("SELECT * FROM services WHERE id = ?").get(id) as ServiceRow | null;
}

export function getServiceByName(name: string, orgId: string): ServiceRow | null {
  return db.query("SELECT * FROM services WHERE name = ? AND org_id = ?").get(name, orgId) as ServiceRow | null;
}

export function getServices(orgId: string): ServiceRow[] {
  return db.query("SELECT * FROM services WHERE org_id = ? ORDER BY created_at DESC").all(orgId) as ServiceRow[];
}

export function getAllServices(): ServiceRow[] {
  return db.query("SELECT * FROM services ORDER BY created_at DESC").all() as ServiceRow[];
}

export function updateServiceStatus(id: number, status: string): void {
  db.query("UPDATE services SET status = ? WHERE id = ?").run(status, id);
}

export function updateServiceCredentials(id: number, credentials: string): void {
  db.query("UPDATE services SET credentials = ? WHERE id = ?").run(credentials, id);
}

export function deleteService(id: number): void {
  db.query("DELETE FROM services WHERE id = ?").run(id);
}

export function insertServiceInstance(data: {
  service_id: number;
  server_id: number;
  role: string;
  container_name: string;
  host_port: number;
  volume_id?: string;
  volume_mount?: string;
  status?: string;
}): ServiceInstanceRow {
  return db
    .query(
      "INSERT INTO service_instances (service_id, server_id, role, container_name, host_port, volume_id, volume_mount, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      data.service_id,
      data.server_id,
      data.role,
      data.container_name,
      data.host_port,
      data.volume_id || "",
      data.volume_mount || "",
      data.status || "deploying"
    ) as ServiceInstanceRow;
}

export function getServiceInstances(serviceId: number): ServiceInstanceRow[] {
  return db
    .query("SELECT * FROM service_instances WHERE service_id = ? ORDER BY created_at ASC")
    .all(serviceId) as ServiceInstanceRow[];
}

export function getServiceInstance(id: number): ServiceInstanceRow | null {
  return db.query("SELECT * FROM service_instances WHERE id = ?").get(id) as ServiceInstanceRow | null;
}

export function getPrimaryInstance(serviceId: number): ServiceInstanceRow | null {
  return db
    .query("SELECT * FROM service_instances WHERE service_id = ? AND role = 'primary'")
    .get(serviceId) as ServiceInstanceRow | null;
}

export function getAllServiceInstances(): ServiceInstanceRow[] {
  return db.query("SELECT * FROM service_instances").all() as ServiceInstanceRow[];
}

export function getServiceInstancesByServer(serverId: number): ServiceInstanceRow[] {
  return db
    .query("SELECT * FROM service_instances WHERE server_id = ?")
    .all(serverId) as ServiceInstanceRow[];
}

export function updateServiceInstanceStatus(id: number, status: string): void {
  db.query("UPDATE service_instances SET status = ? WHERE id = ?").run(status, id);
}

export function updateServiceInstanceMetrics(id: number, cpuPercent: number, memoryPercent: number): void {
  db.query(
    "UPDATE service_instances SET cpu_percent = ?, memory_percent = ?, last_health_at = datetime('now') WHERE id = ?"
  ).run(cpuPercent, memoryPercent, id);
}

export function touchServiceInstanceHealth(id: number): void {
  db.query("UPDATE service_instances SET last_health_at = datetime('now') WHERE id = ?").run(id);
}

export function incrementServiceInstanceUnhealthyTicks(id: number): number {
  db.query("UPDATE service_instances SET unhealthy_ticks = unhealthy_ticks + 1 WHERE id = ?").run(id);
  const row = db.query("SELECT unhealthy_ticks FROM service_instances WHERE id = ?").get(id) as { unhealthy_ticks: number } | null;
  return row?.unhealthy_ticks ?? 0;
}

export function resetServiceInstanceUnhealthyTicks(id: number): void {
  db.query("UPDATE service_instances SET unhealthy_ticks = 0 WHERE id = ?").run(id);
}

export function deleteServiceInstance(id: number): void {
  db.query("DELETE FROM service_instances WHERE id = ?").run(id);
}

const SERVICE_BASE_PORT = 15000;

export function nextServiceHostPort(serverId: number): number {
  const row = db
    .query("SELECT MAX(host_port) as max_port FROM service_instances WHERE server_id = ?")
    .get(serverId) as { max_port: number | null } | null;
  const maxPort = row?.max_port;
  return (maxPort && maxPort >= SERVICE_BASE_PORT) ? maxPort + 1 : SERVICE_BASE_PORT;
}

export function insertServiceLink(serviceId: number, appId: number, envPrefix: string): ServiceLinkRow {
  return db
    .query("INSERT INTO service_links (service_id, app_id, env_prefix) VALUES (?, ?, ?) RETURNING *")
    .get(serviceId, appId, envPrefix) as ServiceLinkRow;
}

export function deleteServiceLink(serviceId: number, appId: number): void {
  db.query("DELETE FROM service_links WHERE service_id = ? AND app_id = ?").run(serviceId, appId);
}

export function getServiceLinks(serviceId: number): ServiceLinkWithAppRow[] {
  return db
    .query("SELECT sl.*, a.name as app_name FROM service_links sl JOIN apps a ON sl.app_id = a.id WHERE sl.service_id = ?")
    .all(serviceId) as ServiceLinkWithAppRow[];
}

export function getLinkedServices(appId: number): ServiceLinkWithServiceRow[] {
  return db
    .query("SELECT sl.*, s.name as service_name, s.service_type, s.credentials FROM service_links sl JOIN services s ON sl.service_id = s.id WHERE sl.app_id = ?")
    .all(appId) as ServiceLinkWithServiceRow[];
}

export function getServicesOnServer(serverId: number): ServiceRow[] {
  return db
    .query(`
      SELECT DISTINCT s.* FROM services s
      JOIN service_instances si ON s.id = si.service_id
      WHERE si.server_id = ?
      ORDER BY s.created_at DESC
    `)
    .all(serverId) as ServiceRow[];
}

