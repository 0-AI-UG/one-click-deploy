import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";
import { handleError } from "../lib/utils.ts";
import {
  createBucket,
  deleteBucket,
  getHetznerS3Credentials,
  HetznerS3Error,
  listBuckets,
  validateBucketName,
} from "../../engine/hetzner/s3.ts";

function providerError(error: unknown): Response {
  if (error instanceof HetznerS3Error) {
    const status = error.code === "BucketAlreadyExists" || error.code === "BucketAlreadyOwnedByYou"
      ? 409
      : error.code === "NoSuchBucket"
        ? 404
        : error.status === 401 || error.status === 403
          ? 403
          : error.status >= 400 && error.status < 500
            ? 400
            : 502;
    return Response.json({ error: error.message, code: error.code }, { status, headers: corsHeaders });
  }
  return handleError(error);
}

export async function handleListBuckets(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");
    const credentials = await getHetznerS3Credentials();
    if (!credentials) {
      return Response.json(
        { configured: false, buckets: [] },
        { headers: corsHeaders },
      );
    }
    return Response.json(
      { configured: true, region: credentials.region, buckets: await listBuckets(credentials) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return providerError(error);
  }
}

export async function handleCreateBucket(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "buckets.create");
    const body = await request.json() as { name?: unknown };
    const checked = validateBucketName(typeof body.name === "string" ? body.name : "");
    if (!checked.valid) {
      return Response.json({ error: checked.error }, { status: 400, headers: corsHeaders });
    }
    const credentials = await getHetznerS3Credentials();
    if (!credentials) {
      return Response.json(
        { error: "Hetzner S3 is not configured. Add S3 credentials in Admin → Infrastructure." },
        { status: 409, headers: corsHeaders },
      );
    }
    await enforceConfirmation(request, payload, "create_bucket", "bucket", checked.value);
    await createBucket(checked.value, credentials);
    return Response.json(
      { ok: true, bucket: { name: checked.value, region: credentials.region } },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return providerError(error);
  }
}

export async function handleDeleteBucket(request: Request, rawName: string): Promise<Response> {
  try {
    const payload = await requirePermission(request, "buckets.delete");
    const checked = validateBucketName(rawName);
    if (!checked.valid) {
      return Response.json({ error: checked.error }, { status: 400, headers: corsHeaders });
    }
    const credentials = await getHetznerS3Credentials();
    if (!credentials) {
      return Response.json({ error: "Hetzner S3 is not configured" }, { status: 409, headers: corsHeaders });
    }
    await enforceConfirmation(request, payload, "delete_bucket", "bucket", checked.value);
    await deleteBucket(checked.value, credentials);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return providerError(error);
  }
}
