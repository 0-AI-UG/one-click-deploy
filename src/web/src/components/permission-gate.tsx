import { useHasPermission } from "../stores/auth.ts";
import type { ReactNode } from "react";

/** Show `children` only when the signed-in user holds `permission`.
 *
 *  Pass `appId` / `environmentId` when the gated control acts on one resource:
 *  a user with only an app- or environment-scoped grant then still sees their
 *  controls. Without them the check is fleet-wide and only a global grant
 *  passes. This is cosmetic — the server re-checks every request. */
export function PermissionGate({
  permission,
  appId,
  environmentId,
  children,
  fallback,
}: {
  permission: string;
  appId?: number | null;
  environmentId?: number | null;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const allowed = useHasPermission(
    permission,
    appId != null || environmentId != null ? { appId, environmentId } : undefined,
  );
  if (!allowed) return fallback ?? null;
  return <>{children}</>;
}
