import { post } from "./api.ts";
import { loadConfig } from "./config.ts";
import { BOLD, GREEN, RED, RESET } from "./format.ts";

function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? "start"
    : process.platform === "darwin" ? "open"
    : "xdg-open";
  Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gate a destructive action behind a browser confirmation. Opens a panel page
 * where the user approves or denies the action, then polls until it resolves.
 * The server builds the human-readable summary from the real resource, so the
 * CLI only sends the resource identity. Returns the `confirm_code` to hand to
 * the delete endpoint (via X-OCD-Confirmation) when the user confirms, or null
 * when denied/expired/timed out.
 */
export async function webConfirm(
  action: string,
  resourceType: string,
  resourceId: number | string,
  opts: { yes?: boolean } = {},
): Promise<string | null> {
  if (opts.yes) {
    // The bearer token authenticating the destructive request is server-signed;
    // this value binds the caller's explicit --yes to one exact action/resource.
    // The server validates both together and never accepts a generic "yes".
    return `automation:${action}:${resourceType}:${resourceId}`;
  }
  const config = loadConfig();
  const panel = config?.panel_url ?? "";

  const { confirm_code, user_code, expires_in, summary } = await post<{
    confirm_code: string;
    user_code: string;
    expires_in: number;
    summary: string;
  }>("/api/confirmations", { action, resource_type: resourceType, resource_id: resourceId });

  const url = `${panel}/#/cli/confirm/${user_code}`;

  console.log();
  console.log(`  ${RED}This action needs confirmation in your browser:${RESET}`);
  console.log(`  ${summary}`);
  console.log();
  console.log(`  Open: ${BOLD}${url}${RESET}`);
  console.log(`  Code: ${BOLD}${user_code}${RESET}`);
  console.log(`  Waiting for confirmation…`);

  openBrowser(url);

  const deadline = Date.now() + expires_in * 1000;
  const POLL = 2000;

  while (Date.now() < deadline) {
    await sleep(POLL);

    const { status } = await post<{ status: string }>("/api/confirmations/poll", { confirm_code });

    if (status === "confirmed") {
      console.log(`${GREEN}  Confirmed.${RESET}`);
      return confirm_code;
    }
    if (status === "denied") {
      console.log(`${RED}  Denied.${RESET}`);
      return null;
    }
    if (status === "expired") {
      console.log(`${RED}  Confirmation expired.${RESET}`);
      return null;
    }
    // pending — keep polling
  }

  console.log(`${RED}  Timed out waiting for confirmation.${RESET}`);
  return null;
}
