import { useHasPermission } from "../stores/auth.ts";
import type { ReactNode } from "react";

export function PermissionGate({
  permission,
  children,
  fallback,
}: {
  permission: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const allowed = useHasPermission(permission);
  if (!allowed) return fallback ?? null;
  return <>{children}</>;
}
