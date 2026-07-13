import db from "./connection.ts";
import type { AppRow } from "./apps.ts";
import type { ServiceRow } from "./services.ts";

export type StackRow = {
  id: number;
  name: string;
  environment_id: number | null;
  status: string;
  deploy_log: string;
  created_at: string;
};

export function insertStack(data: { name: string; environment_id: number | null }): StackRow {
  const result = db.query(
    "INSERT INTO stacks (name, environment_id) VALUES (?, ?) RETURNING *"
  ).get(data.name, data.environment_id) as StackRow;
  return result;
}

export function getStack(id: number): StackRow | null {
  return db.query("SELECT * FROM stacks WHERE id = ?").get(id) as StackRow | null;
}

export function getStackByName(name: string): StackRow | null {
  return db.query("SELECT * FROM stacks WHERE name = ?").get(name) as StackRow | null;
}

export function getStacks(): StackRow[] {
  return db.query("SELECT * FROM stacks ORDER BY created_at DESC").all() as StackRow[];
}

export function updateStackStatus(id: number, status: string): void {
  db.query("UPDATE stacks SET status = ? WHERE id = ?").run(status, id);
}

export function appendStackLog(id: number, line: string): void {
  db.query(
    "UPDATE stacks SET deploy_log = deploy_log || ? WHERE id = ?"
  ).run(line + "\n", id);
}

export function getStackLog(id: number): string {
  const row = db
    .query("SELECT deploy_log FROM stacks WHERE id = ?")
    .get(id) as { deploy_log: string } | null;
  return row?.deploy_log ?? "";
}

export function deleteStack(id: number): void {
  db.query("DELETE FROM stacks WHERE id = ?").run(id);
}

export function getAppsByStackId(stackId: number): AppRow[] {
  return db.query("SELECT * FROM apps WHERE stack_id = ?").all(stackId) as AppRow[];
}

export function getServicesByStackId(stackId: number): ServiceRow[] {
  return db.query("SELECT * FROM services WHERE stack_id = ?").all(stackId) as ServiceRow[];
}

export function setAppStack(appId: number, stackId: number | null): void {
  db.query("UPDATE apps SET stack_id = ? WHERE id = ?").run(stackId, appId);
}

export function setServiceStack(serviceId: number, stackId: number | null): void {
  db.query("UPDATE services SET stack_id = ? WHERE id = ?").run(stackId, serviceId);
}
