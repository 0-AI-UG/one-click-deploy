import db from "./connection.ts";

export function insertService(data: {
  name: string;
  service_type: string;
  version: string;
  port: number;
  env_vars: string;
  credentials: string;
  desired_instances?: number;
}): any {
  return db
    .query(
      "INSERT INTO services (name, service_type, version, port, env_vars, credentials, desired_instances) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(data.name, data.service_type, data.version, data.port, data.env_vars, data.credentials, data.desired_instances ?? 1);
}

export function getService(id: number): any {
  return db.query("SELECT * FROM services WHERE id = ?").get(id);
}

export function getServiceByName(name: string): any {
  return db.query("SELECT * FROM services WHERE name = ?").get(name);
}

export function getServices(): any[] {
  return db.query("SELECT * FROM services ORDER BY created_at DESC").all() as any[];
}

export function updateServiceStatus(id: number, status: string): void {
  db.query("UPDATE services SET status = ? WHERE id = ?").run(status, id);
}

export function updateServiceCredentials(id: number, credentials: string): void {
  db.query("UPDATE services SET credentials = ? WHERE id = ?").run(credentials, id);
}

export function updateServiceDesiredInstances(id: number, count: number): void {
  db.query("UPDATE services SET desired_instances = ? WHERE id = ?").run(count, id);
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
}): any {
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
    );
}

export function getServiceInstances(serviceId: number): any[] {
  return db
    .query("SELECT * FROM service_instances WHERE service_id = ? ORDER BY created_at ASC")
    .all(serviceId) as any[];
}

export function getServiceInstance(id: number): any {
  return db.query("SELECT * FROM service_instances WHERE id = ?").get(id);
}

export function getPrimaryInstance(serviceId: number): any {
  return db
    .query("SELECT * FROM service_instances WHERE service_id = ? AND role = 'primary'")
    .get(serviceId);
}

export function getReplicaInstances(serviceId: number): any[] {
  return db
    .query("SELECT * FROM service_instances WHERE service_id = ? AND role = 'replica' ORDER BY created_at ASC")
    .all(serviceId) as any[];
}

export function getAllServiceInstances(): any[] {
  return db.query("SELECT * FROM service_instances").all() as any[];
}

export function getServiceInstancesByServer(serverId: number): any[] {
  return db
    .query("SELECT * FROM service_instances WHERE server_id = ?")
    .all(serverId) as any[];
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
  const row = db.query("SELECT unhealthy_ticks FROM service_instances WHERE id = ?").get(id) as any;
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
    .get(serverId) as any;
  const maxPort = row?.max_port;
  return (maxPort && maxPort >= SERVICE_BASE_PORT) ? maxPort + 1 : SERVICE_BASE_PORT;
}

export function insertServiceLink(serviceId: number, appId: number, envPrefix: string): any {
  return db
    .query("INSERT INTO service_links (service_id, app_id, env_prefix) VALUES (?, ?, ?) RETURNING *")
    .get(serviceId, appId, envPrefix);
}

export function deleteServiceLink(serviceId: number, appId: number): void {
  db.query("DELETE FROM service_links WHERE service_id = ? AND app_id = ?").run(serviceId, appId);
}

export function getServiceLinks(serviceId: number): any[] {
  return db
    .query("SELECT sl.*, a.name as app_name FROM service_links sl JOIN apps a ON sl.app_id = a.id WHERE sl.service_id = ?")
    .all(serviceId) as any[];
}

export function getLinkedServices(appId: number): any[] {
  return db
    .query("SELECT sl.*, s.name as service_name, s.service_type, s.credentials FROM service_links sl JOIN services s ON sl.service_id = s.id WHERE sl.app_id = ?")
    .all(appId) as any[];
}

export function getServicesOnServer(serverId: number): any[] {
  return db
    .query(`
      SELECT DISTINCT s.* FROM services s
      JOIN service_instances si ON s.id = si.service_id
      WHERE si.server_id = ?
      ORDER BY s.created_at DESC
    `)
    .all(serverId) as any[];
}

export function createServiceDeployJob(serviceName: string): { id: number } {
  return db
    .query("INSERT INTO service_deploy_jobs (service_name) VALUES (?) RETURNING id")
    .get(serviceName) as { id: number };
}

export function appendServiceDeployJobEvent(jobId: number, step: string, detail: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM service_deploy_job_events WHERE job_id = ?")
    .get(jobId) as { next: number };
  db.query(
    "INSERT INTO service_deploy_job_events (job_id, seq, step, detail) VALUES (?, ?, ?, ?)"
  ).run(jobId, row.next, step, detail);
  return row.next;
}

export function finishServiceDeployJob(jobId: number, result: { ok: boolean; error?: string }): void {
  db.query(
    "UPDATE service_deploy_jobs SET status = ?, result_json = ?, finished_at = datetime('now') WHERE id = ?"
  ).run(result.ok ? "done" : "error", JSON.stringify(result), jobId);
}

export function getServiceDeployJob(id: number): any {
  return db.query("SELECT * FROM service_deploy_jobs WHERE id = ?").get(id);
}

export function getServiceDeployJobEvents(jobId: number, sinceSeq: number): any[] {
  return db
    .query(
      "SELECT seq, ts, step, detail FROM service_deploy_job_events WHERE job_id = ? AND seq > ? ORDER BY seq ASC"
    )
    .all(jobId, sinceSeq) as any[];
}
