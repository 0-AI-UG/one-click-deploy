import { useSyncExternalStore } from "react";

import type { PermissionGrant, PermissionScope } from "../types.ts";

export type User = {
  id: string;
  username: string;
  isAdmin: boolean;
  webauthnEnabled?: boolean;
  githubLinked?: boolean;
  githubUsername?: string;
  githubAvatarUrl?: string;
  /** Global permissions only — what this account can do fleet-wide. */
  permissions: string[];
  /** Every grant, scope included. Absent on a session stored before scoped
   *  grants existed; `/api/me` refills it on load. */
  grants?: PermissionGrant[];
};

type AuthState = {
  token: string | null;
  user: User | null;
  tempToken: string | null;
};

let state: AuthState = loadFromStorage();

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function loadFromStorage(): AuthState {
  try {
    const stored = localStorage.getItem("ocd-auth");
    if (stored) {
      const parsed = JSON.parse(stored);
      return { token: parsed.token || null, user: parsed.user || null, tempToken: null };
    }
  } catch (err) {
    console.error("Failed to load auth state from storage:", err);
  }
  return { token: null, user: null, tempToken: null };
}

function saveToStorage() {
  if (state.token && state.user) {
    localStorage.setItem("ocd-auth", JSON.stringify({ token: state.token, user: state.user }));
  } else {
    localStorage.removeItem("ocd-auth");
  }
}

export function login(token: string, user: User) {
  state = { ...state, token, user, tempToken: null };
  saveToStorage();
  notify();
}

export function logout() {
  state = { token: null, user: null, tempToken: null };
  saveToStorage();
  notify();
}

export function setTempToken(tempToken: string) {
  state = { ...state, tempToken };
  notify();
}

export function updateUser(user: User) {
  state = { ...state, user };
  saveToStorage();
  notify();
}

export function getToken(): string | null {
  return state.token;
}

export function useAuth() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

/** Mirror of the server's rule (see shared/db/users.ts `hasPermission`):
 *  a global grant always passes; with a scope, a grant on that exact app or on
 *  that environment passes too. Without a scope only a global grant counts, so
 *  a narrowly-scoped user does not see fleet-wide controls.
 *
 *  The one thing the browser cannot do is resolve an app's environment on its
 *  own, so callers acting on an app should pass `environmentId` alongside
 *  `appId` when they have it. Missing it only over-hides — never over-shows. */
function evaluate(user: User | null, permission: string, scope?: PermissionScope): boolean {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (user.permissions.includes(permission)) return true;
  if (!scope) return false;
  const grants = user.grants;
  if (!grants) return false;
  return grants.some((g) => {
    if (g.permission !== permission) return false;
    if (g.scopeType === "app") return scope.appId != null && g.scopeId === String(scope.appId);
    if (g.scopeType === "environment") {
      return scope.environmentId != null && g.scopeId === String(scope.environmentId);
    }
    return false;
  });
}

export function can(permission: string, scope?: PermissionScope): boolean {
  return evaluate(state.user, permission, scope);
}

export function hasPermission(permission: string, scope?: PermissionScope): boolean {
  return evaluate(state.user, permission, scope);
}

export function useCan(permission: string, scope?: PermissionScope): boolean {
  const auth = useAuth();
  return evaluate(auth.user, permission, scope);
}

export function useHasPermission(permission: string, scope?: PermissionScope): boolean {
  const auth = useAuth();
  return evaluate(auth.user, permission, scope);
}
