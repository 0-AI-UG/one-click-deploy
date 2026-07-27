import db from "./connection.ts";
import type { ResourceUsage } from "./replicas.ts";
import * as health from "./_metrics-health.ts";

export type ServiceRow = {
  id: number;
  name: string;
  service_type: string;
  version: string;
  status: string;
  port: number;
  env_vars: string;
  credentials: string;
  desired_instances: number;
  stack_id: number | null;
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
  /** 0 = volume CREATED by us (deleted on destroy); 1 = an EXISTING volume
   *  ATTACHED (detached-not-deleted on destroy). Service deploys only ever
   *  create volumes, so this is 0 today — wired for parity with apps. */
  volume_attached: number;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  cpu_limit_cores: number;
  memory_used_mb: number;
  memory_limit_mb: number;
  unhealthy_ticks: number;
  last_health_at: string | null;
  created_at: string;
};

export type ServiceLinkRow = {
  id: number;
  service_id: number;
  environment_id: number;
  env_prefix: string;
  created_at: string;
};

export type ServiceLinkWithEnvironmentRow = ServiceLinkRow & { environment_name: string };

export function insertService(data: {
  name: string;
  service_type: string;
  version: string;
  port: number;
  env_vars: string;
  credentials: string;
  desired_instances?: number;
}): ServiceRow {
  return db
    .query(
      "INSERT INTO services (name, service_type, version, port, env_vars, credentials, desired_instances) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(data.name, data.service_type, data.version, data.port, data.env_vars, data.credentials, data.desired_instances ?? 1) as ServiceRow;
}

export function getService(id: number): ServiceRow | null {
  return db.query("SELECT * FROM services WHERE id = ?").get(id) as ServiceRow | null;
}

export function getServiceByName(name: string): ServiceRow | null {
  return db.query("SELECT * FROM services WHERE name = ?").get(name) as ServiceRow | null;
}

export function getServices(): ServiceRow[] {
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
  health.updateStatus("service_instances", id, status);
}

export function updateServiceInstanceMetrics(
  id: number,
  cpuPercent: number,
  memoryPercent: number,
  usage?: ResourceUsage,
): void {
  health.updateMetrics("service_instances", id, cpuPercent, memoryPercent, usage);
}

export function touchServiceInstanceHealth(id: number): void {
  health.touchHealth("service_instances", id);
}

export function incrementServiceInstanceUnhealthyTicks(id: number): number {
  return health.incrementUnhealthyTicks("service_instances", id);
}

export function resetServiceInstanceUnhealthyTicks(id: number): void {
  health.resetUnhealthyTicks("service_instances", id);
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

export function insertServiceLink(serviceId: number, environmentId: number, envPrefix: string): ServiceLinkRow {
  return db
    .query(
      "INSERT INTO service_links (service_id, environment_id, env_prefix) VALUES (?, ?, ?) " +
      "ON CONFLICT(service_id, environment_id) DO UPDATE SET env_prefix = excluded.env_prefix RETURNING *"
    )
    .get(serviceId, environmentId, envPrefix) as ServiceLinkRow;
}

export function deleteServiceLink(serviceId: number, environmentId: number): void {
  db.query("DELETE FROM service_links WHERE service_id = ? AND environment_id = ?").run(serviceId, environmentId);
}

export function getServiceLinks(serviceId: number): ServiceLinkWithEnvironmentRow[] {
  return db
    .query("SELECT sl.*, e.name as environment_name FROM service_links sl JOIN environments e ON sl.environment_id = e.id WHERE sl.service_id = ?")
    .all(serviceId) as ServiceLinkWithEnvironmentRow[];
}

export function getServiceLinksByEnvironmentId(environmentId: number): ServiceLinkWithEnvironmentRow[] {
  return db
    .query(
      `SELECT sl.*, e.name as environment_name
       FROM service_links sl
       JOIN environments e ON sl.environment_id = e.id
       WHERE sl.environment_id = ?`,
    )
    .all(environmentId) as ServiceLinkWithEnvironmentRow[];
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
