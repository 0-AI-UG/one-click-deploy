import db from "./connection.ts";
import type { ResourceUsage } from "./replicas.ts";

/** Tables that share the health/metrics column shape. Passed as a literal from
 *  each caller so the table name is never an arbitrary string (no injection). */
type HealthTable = "replicas" | "service_instances";

export function updateStatus(table: HealthTable, id: number, status: string): void {
  db.query(`UPDATE ${table} SET status = ? WHERE id = ?`).run(status, id);
}

export function updateMetrics(
  table: HealthTable,
  id: number,
  cpuPercent: number,
  memoryPercent: number,
  usage?: ResourceUsage,
): void {
  db.query(
    `UPDATE ${table} SET cpu_percent = ?, memory_percent = ?,
       cpu_limit_cores = ?, memory_used_mb = ?, memory_limit_mb = ?,
       last_health_at = datetime('now') WHERE id = ?`
  ).run(
    cpuPercent,
    memoryPercent,
    usage?.cpuLimitCores ?? 0,
    usage?.memoryUsedMb ?? 0,
    usage?.memoryLimitMb ?? 0,
    id,
  );
}

export function touchHealth(table: HealthTable, id: number): void {
  db.query(`UPDATE ${table} SET last_health_at = datetime('now') WHERE id = ?`).run(id);
}

export function incrementUnhealthyTicks(table: HealthTable, id: number): number {
  db.query(`UPDATE ${table} SET unhealthy_ticks = unhealthy_ticks + 1 WHERE id = ?`).run(id);
  const row = db.query(`SELECT unhealthy_ticks FROM ${table} WHERE id = ?`).get(id) as { unhealthy_ticks: number } | null;
  return row?.unhealthy_ticks ?? 0;
}

export function resetUnhealthyTicks(table: HealthTable, id: number): void {
  db.query(`UPDATE ${table} SET unhealthy_ticks = 0 WHERE id = ?`).run(id);
}
