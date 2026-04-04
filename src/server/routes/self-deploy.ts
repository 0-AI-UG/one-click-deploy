import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { deploy } from "../../bun/deploy/index.ts";
import { notifyProgress } from "./apps.ts";

const REPO_URL = "https://github.com/0-AI-UG/one-click-deploy.git";
const APP_NAME = "ocd-panel";

export async function handleSelfDeploy(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "apps.deploy");
    const body = await request.json() as {
      domain: string;
      server_id?: number;
      server_type?: string;
      server_location?: string;
    };

    const jwtSecret = crypto.randomUUID() + crypto.randomUUID();
    const progressKey = `deploy-${APP_NAME}`;

    const result = await deploy(
      {
        app_name: APP_NAME,
        domain: body.domain || undefined,
        git_repo: REPO_URL,
        container_port: 3001,
        env_vars: {
          OCD_MODE: "server",
          NODE_ENV: "production",
          JWT_SECRET: jwtSecret,
          OCD_DATA_DIR: "/app/data",
          PORT: "3001",
        },
        server_id: body.server_id,
        server_type: body.server_type,
        server_location: body.server_location,
        volume_size: 10,
        volume_path: "/app/data",
      },
      (step, detail) => notifyProgress(progressKey, step, detail),
    );

    const url = result.ok
      ? body.domain ? `https://${body.domain}` : undefined
      : undefined;
    return Response.json({ ...result, url }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
