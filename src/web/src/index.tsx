import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { configureClient } from "./api/client.ts";
import { getToken, logout } from "./stores/auth.ts";

configureClient({
  getToken,
  onUnauthorized: () => {
    logout();
    window.location.hash = "#/login";
  },
});

createRoot(document.getElementById("root")!).render(<App />);
