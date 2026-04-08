import { useState, useEffect } from "react";
import { useAuth } from "./stores/auth.ts";
import { get } from "./api/client.ts";
import { Toasts, ConfirmDialog, Spinner } from "./components/ui.tsx";
import { Nav } from "./components/nav.tsx";
import { ProtectedRoute } from "./components/protected-route.tsx";
import { LoginPage } from "./pages/login.tsx";
import { TotpVerifyPage } from "./pages/totp-verify.tsx";
import { TotpSetupPage } from "./pages/totp-setup.tsx";
import { PasswordResetPage } from "./pages/password-reset.tsx";
import { SetupPage } from "./pages/setup.tsx";
import { DashboardPage } from "./pages/dashboard.tsx";
import { DeployPage } from "./pages/deploy.tsx";
import { DeployProgressPage } from "./pages/deploy-progress.tsx";
import { AppDetailPage } from "./pages/app-detail.tsx";
import { ResourcesPage } from "./pages/resources.tsx";
import { SettingsPage } from "./pages/settings.tsx";
import { UsersPage } from "./pages/admin/users.tsx";
import { UserDetailPage } from "./pages/admin/user-detail.tsx";
import { TerminalPage } from "./pages/terminal.tsx";

function useHash() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const handler = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const { token, tempToken } = useAuth();
  const [setupChecked, setSetupChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    get("/api/setup/status").then((res) => {
      const incomplete = !res.setupComplete;
      setNeedsSetup(incomplete);
      setSetupChecked(true);
      if (incomplete && !token) {
        if (window.location.hash !== "#/setup") {
          window.location.hash = "#/setup";
        }
      }
    }).catch(() => {
      setSetupChecked(true);
    });
  }, []);

  // Once a temp token appears (setup just completed, or login is mid-2FA),
  // re-check setup status so the guard below stops forcing #/setup.
  useEffect(() => {
    if (!tempToken) return;
    get("/api/setup/status").then((res) => {
      setNeedsSetup(!res.setupComplete);
    }).catch(() => {});
  }, [tempToken]);

  if (!setupChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // If setup isn't complete and the user isn't already authenticated,
  // only the setup page is reachable. (An authenticated user has passed setup.)
  if (needsSetup && !token && !tempToken && hash !== "#/setup") {
    window.location.hash = "#/setup";
    return null;
  }

  // Public routes (no auth required)
  if (hash === "#/setup") {
    // Setup just completed and we have a temp token — go finish 2FA setup.
    if (tempToken) {
      window.location.hash = "#/totp-setup";
      return null;
    }
    // Once setup is complete, the setup page is no longer reachable —
    // bounce to the dashboard (if authenticated) or login page.
    if (!needsSetup) {
      window.location.hash = token ? "#/" : "#/login";
      return null;
    }
    return <><SetupPage /><Toasts /><ConfirmDialog /></>;
  }
  if (hash === "#/login") return <><LoginPage /><Toasts /><ConfirmDialog /></>;
  if (hash === "#/password-reset") return <><PasswordResetPage /><Toasts /><ConfirmDialog /></>;
  if (hash === "#/totp-verify") return <><TotpVerifyPage /><Toasts /><ConfirmDialog /></>;
  if (hash === "#/totp-setup") return <><TotpSetupPage /><Toasts /><ConfirmDialog /></>;

  // Redirect to login if not authenticated
  if (!token) {
    if (needsSetup) {
      window.location.hash = "#/setup";
    } else {
      window.location.hash = "#/login";
    }
    return null;
  }

  // Parse route
  let content;
  if (hash === "#/" || hash === "") {
    content = <DashboardPage />;
  } else if (hash === "#/deploy") {
    content = <DeployPage />;
  } else if (hash.startsWith("#/deploy/progress")) {
    const parts = hash.split("/");
    const jobId = parts[3] ? parseInt(parts[3], 10) : null;
    content = <DeployProgressPage jobId={jobId && !Number.isNaN(jobId) ? jobId : null} />;
  } else if (hash.startsWith("#/apps/")) {
    const appId = parseInt(hash.split("/")[2], 10);
    content = appId ? <AppDetailPage appId={appId} /> : <DashboardPage />;
  } else if (hash === "#/resources") {
    content = <ResourcesPage />;
  } else if (hash === "#/settings") {
    content = <SettingsPage />;
  } else if (hash === "#/admin/users") {
    content = <UsersPage />;
  } else if (hash.startsWith("#/terminal/")) {
    const parts = hash.split("/");
    const kind = parts[2] as "server" | "replica";
    const id = parseInt(parts[3], 10);
    content = (kind === "server" || kind === "replica") && id
      ? <TerminalPage kind={kind} id={id} />
      : <DashboardPage />;
  } else if (hash.startsWith("#/admin/users/")) {
    const userId = hash.split("/")[3];
    content = userId ? <UserDetailPage userId={userId} /> : <UsersPage />;
  } else {
    content = <DashboardPage />;
  }

  return (
    <>
      <Nav />
      <ProtectedRoute>{content}</ProtectedRoute>
      <Toasts />
      <ConfirmDialog />
    </>
  );
}
