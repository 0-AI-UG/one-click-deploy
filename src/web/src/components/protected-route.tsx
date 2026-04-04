import { useAuth } from "../stores/auth.ts";
import type { ReactNode } from "react";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { token } = useAuth();

  if (!token) {
    window.location.hash = "#/login";
    return null;
  }

  return <>{children}</>;
}
