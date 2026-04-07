import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { configureClient } from "./api/client.ts";
import { getToken, logout } from "./stores/auth.ts";

configureClient({
  getToken,
  onUnauthorized: () => {
    // If there's no token to begin with, don't redirect — the request was
    // anonymous (e.g. during /setup), and bouncing to /login would clobber
    // the in-progress route.
    if (!getToken()) return;
    logout();
    window.location.hash = "#/login";
  },
});

createRoot(document.getElementById("root")!).render(<App />);
