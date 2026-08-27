import db from "./connection.ts";

const IMMUTABLE_IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i;

function assertImmutableImageRef(imageRef: string): void {
  if (!IMMUTABLE_IMAGE.test(imageRef)) {
    throw new Error("image_ref must be an immutable OCI reference ending in @sha256:<64 hex digest>");
  }
}

export type PanelRow = {
  id: number;
  server_id: number;
  name: string;
  domain: string;
  image_ref: string;
  container_port: number;
  host_port: number;
  volume_id: string;
  volume_mount: string;
  env_vars: string;
  status: string;
  deploy_log: string;
  created_at: string;
};

export type PanelDeploymentRow = {
  id: number;
  image_tag: string;
  git_commit: string;
  status: string;
  source: string;
  deploy_log: string;
  created_at: string;
};

export function getPanel(): PanelRow | null {
  return (db.query("SELECT * FROM panel WHERE id = 1").get() as PanelRow) || null;
}

export function insertPanel(panel: {
  server_id: number;
  name: string;
  domain: string;
  image_ref: string;
  container_port: number;
  host_port: number;
  volume_id?: string;
  volume_mount?: string;
  env_vars?: string;
  status?: string;
}): PanelRow {
  assertImmutableImageRef(panel.image_ref);
  return db
    .query(
      "INSERT INTO panel (id, server_id, name, domain, image_ref, container_port, host_port, volume_id, volume_mount, env_vars, status) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(
      panel.server_id,
      panel.name,
      panel.domain,
      panel.image_ref,
      panel.container_port,
      panel.host_port,
      panel.volume_id ?? "",
      panel.volume_mount ?? "",
      panel.env_vars ?? "{}",
      panel.status ?? "running",
    ) as PanelRow;
}

export function updatePanelStatus(status: string): void {
  db.query("UPDATE panel SET status = ? WHERE id = 1").run(status);
}

export function updatePanelEnvVars(envVars: string): void {
  db.query("UPDATE panel SET env_vars = ? WHERE id = 1").run(envVars);
}

export function appendPanelDeployLog(line: string): void {
  db.query("UPDATE panel SET deploy_log = deploy_log || ? WHERE id = 1").run(line + "\n");
}

export function getPanelDeployLog(): string {
  const row = db.query("SELECT deploy_log FROM panel WHERE id = 1").get() as { deploy_log: string } | null;
  return row?.deploy_log ?? "";
}

export function deletePanel(): void {
  db.query("DELETE FROM panel WHERE id = 1").run();
}

export function insertPanelDeployment(deployment: {
  image_tag: string;
  git_commit: string;
  status?: string;
  source?: string;
  deploy_log?: string;
}): PanelDeploymentRow {
  assertImmutableImageRef(deployment.image_tag);
  const status = deployment.status ?? "deployed";
  const tx = db.transaction(() => {
    const row = db
      .query(
        "INSERT INTO panel_deployments (image_tag, git_commit, status, source, deploy_log) VALUES (?, ?, ?, ?, ?) RETURNING *",
      )
      .get(
        deployment.image_tag,
        deployment.git_commit,
        status,
        deployment.source ?? "manual",
        deployment.deploy_log ?? "",
      ) as PanelDeploymentRow;
    if (status === "deployed") {
      db.query("UPDATE panel SET image_ref = ? WHERE id = 1").run(deployment.image_tag);
    }
    return row;
  });
  return tx();
}

export function getPanelDeployments(): PanelDeploymentRow[] {
  return db
    .query("SELECT * FROM panel_deployments ORDER BY created_at DESC LIMIT 50")
    .all() as PanelDeploymentRow[];
}
