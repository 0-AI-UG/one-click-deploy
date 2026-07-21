import { loadConfig, saveConfig } from "../config.ts";
import { BOLD, GREEN, DIM, RESET } from "../format.ts";
import { CLI_ACCESS_DENIED_MESSAGE } from "../api.ts";

function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? "start"
    : process.platform === "darwin" ? "open"
    : "xdg-open";
  Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function login(args: string[]): Promise<void> {
  let panelUrl = args[0];

  if (!panelUrl) {
    const existing = loadConfig();
    if (existing?.panel_url) {
      panelUrl = existing.panel_url;
    } else {
      console.error("Usage: ocd login <panel-url>");
      console.error("Example: ocd login https://panel.example.com");
      process.exit(1);
    }
  }

  // Normalize URL
  panelUrl = panelUrl.replace(/\/+$/, "");
  if (!panelUrl.startsWith("http://") && !panelUrl.startsWith("https://")) {
    panelUrl = "https://" + panelUrl;
  }

  // Request device code
  const codeRes = await fetch(`${panelUrl}/api/auth/device-code`, { method: "POST" });
  if (!codeRes.ok) {
    console.error("Failed to start login flow. Is the panel URL correct?");
    process.exit(1);
  }

  const { device_code, user_code, expires_in } = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
    expires_in: number;
  };

  const authUrl = `${panelUrl}/#/cli/auth`;

  console.log();
  console.log(`  Open this URL in your browser:`);
  console.log(`  ${BOLD}${authUrl}${RESET}`);
  console.log();
  console.log(`  And enter code: ${BOLD}${user_code}${RESET}`);
  console.log();
  console.log(`${DIM}  Waiting for authorization...${RESET}`);

  openBrowser(authUrl);

  // Poll for token
  const deadline = Date.now() + expires_in * 1000;
  const POLL_INTERVAL = 2000;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);

    const tokenRes = await fetch(`${panelUrl}/api/auth/device-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code }),
    });

    if (tokenRes.ok) {
      const { token } = (await tokenRes.json()) as { token: string };

      // Fetch username. /api/me also reports the account's global permissions,
      // which lets us warn here rather than letting the first real command die
      // on a 403 the user cannot connect back to this login.
      let username: string | undefined;
      let cliAccessDenied = false;
      try {
        const meRes = await fetch(`${panelUrl}/api/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (meRes.ok) {
          const me = (await meRes.json()) as {
            user?: { username?: string; isAdmin?: boolean; permissions?: string[] };
          };
          username = me.user?.username;
          if (me.user && !me.user.isAdmin && Array.isArray(me.user.permissions)) {
            cliAccessDenied = !me.user.permissions.includes("cli.access");
          }
        }
      } catch {}

      saveConfig({ panel_url: panelUrl, token, username });
      console.log(`${GREEN}  Logged in${username ? ` as ${BOLD}${username}` : ""}${RESET}`);
      if (cliAccessDenied) console.error(`  ${CLI_ACCESS_DENIED_MESSAGE}`);
      return;
    }

    if (tokenRes.status === 410) {
      console.error("  Code expired. Run `ocd login` again.");
      process.exit(1);
    }
    if (tokenRes.status === 403) {
      console.error("  Authorization denied.");
      process.exit(1);
    }
    // 428 = pending, keep polling
  }

  console.error("  Timed out waiting for authorization. Run `ocd login` again.");
  process.exit(1);
}
