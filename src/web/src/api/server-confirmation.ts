import { apiFetch, post } from "./client.ts";

type Confirmation = {
  confirm_code: string;
  user_code: string;
};

/**
 * Convert an already-approved browser dialog into a server-issued, single-use,
 * resource-bound confirmation. The destructive route consumes the token, so a
 * bare authenticated DELETE cannot bypass the UI's confirmation step.
 */
export async function serverConfirmedDelete<T>(
  path: string,
  action: "delete_stack" | "delete_environment" | "purge_environment" | "delete_volume",
  resourceType: string,
  resourceId: string | number,
  typedResourceId?: string,
): Promise<T> {
  const confirmation = await post("/api/confirmations", {
    action,
    resource_type: resourceType,
    resource_id: resourceId,
  }) as Confirmation;

  await post(
    `/api/confirmations/item/${encodeURIComponent(confirmation.user_code)}/confirm`,
    action === "delete_volume" ? { typed_resource_id: typedResourceId } : undefined,
  );

  return apiFetch<T>(path, {
    method: "DELETE",
    headers: { "X-OCD-Confirmation": confirmation.confirm_code },
  });
}
