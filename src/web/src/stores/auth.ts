import { useSyncExternalStore } from "react";

export type User = {
  id: string;
  username: string;
  totpEnabled?: boolean;
  webauthnEnabled?: boolean;
  githubLinked?: boolean;
  githubUsername?: string;
  githubAvatarUrl?: string;
  permissions: string[];
};

export type TwoFactorMethods = {
  totp: boolean;
  webauthn: boolean;
};

export type OrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

type AuthState = {
  token: string | null;
  user: User | null;
  tempToken: string | null;
  twoFactorMethods: TwoFactorMethods | null;
  currentOrgId: string | null;
  orgs: OrgSummary[];
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
      return { token: parsed.token || null, user: parsed.user || null, currentOrgId: parsed.currentOrgId || null, orgs: [], tempToken: null, twoFactorMethods: null };
    }
  } catch (err) {
    console.error("Failed to load auth state from storage:", err);
  }
  return { token: null, user: null, currentOrgId: null, orgs: [], tempToken: null, twoFactorMethods: null };
}

function saveToStorage() {
  if (state.token && state.user) {
    localStorage.setItem("ocd-auth", JSON.stringify({ token: state.token, user: state.user, currentOrgId: state.currentOrgId }));
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
  state = { token: null, user: null, currentOrgId: null, orgs: [], tempToken: null, twoFactorMethods: null };
  saveToStorage();
  notify();
}

export function setTempToken(tempToken: string, twoFactorMethods?: TwoFactorMethods) {
  state = { ...state, tempToken, twoFactorMethods: twoFactorMethods ?? state.twoFactorMethods };
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

export function setOrgs(orgs: OrgSummary[]) {
  state = { ...state, orgs };
  // Auto-select first org if none selected
  if (!state.currentOrgId && orgs.length > 0) {
    state = { ...state, currentOrgId: orgs[0].id };
    saveToStorage();
  }
  notify();
}

export function setCurrentOrg(orgId: string) {
  state = { ...state, currentOrgId: orgId };
  saveToStorage();
  notify();
}

export function getCurrentOrgId(): string | null {
  return state.currentOrgId;
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

export function hasPermission(permission: string): boolean {
  if (!state.user) return false;
  return state.user.permissions.includes(permission);
}

export function useHasPermission(permission: string): boolean {
  const auth = useAuth();
  if (!auth.user) return false;
  return auth.user.permissions.includes(permission);
}
