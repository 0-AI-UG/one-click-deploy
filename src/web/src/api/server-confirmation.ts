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
  action: "delete_app" | "delete_service" | "delete_server" | "delete_stack" | "delete_environment" | "purge_environment" | "delete_volume",
  resourceType: string,
  resourceId: string | number,
  typedResource?: string,
): Promise<T> {
  const confirmation = await post("/api/confirmations", {
    action,
    resource_type: resourceType,
    resource_id: resourceId,
  }) as Confirmation;

  await post(
    `/api/confirmations/item/${encodeURIComponent(confirmation.user_code)}/confirm`,
    action === "delete_volume"
      ? { typed_resource_id: typedResource }
      : action === "purge_environment"
        ? { typed_resource_name: typedResource }
        : undefined,
  );

  return apiFetch<T>(path, {
    method: "DELETE",
    headers: { "X-OCD-Confirmation": confirmation.confirm_code },
  });
}

export async function serverConfirmedAction<T>(
  path: string,
  method: "POST" | "DELETE",
  action: "create_server" | "promote_app" | "promote_stack" | "cancel_operation",
  resourceType: string,
  resourceId: string | number,
  body?: unknown,
): Promise<T> {
  const confirmation = await post("/api/confirmations", {
    action,
    resource_type: resourceType,
    resource_id: resourceId,
  }) as Confirmation;
  await post(`/api/confirmations/item/${encodeURIComponent(confirmation.user_code)}/confirm`);
  return apiFetch<T>(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-OCD-Confirmation": confirmation.confirm_code,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
