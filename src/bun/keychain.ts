const SERVICE = "com.one-click-deploy";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [keychain:${context}]`, ...args);
}

export async function setSecret(
  account: string,
  secret: string
): Promise<void> {
  log("set", `Setting secret for account: ${account}`);
  const proc = Bun.spawn(
    [
      "security",
      "add-generic-password",
      "-a", account,
      "-s", SERVICE,
      "-w", secret,
      "-U", // Update if exists
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error("Failed to store secret in Keychain — check that the app has Keychain access");
  }
  log("set", `Secret stored for account: ${account}`);
}

export async function getSecret(
  account: string
): Promise<string | null> {
  const proc = Bun.spawn(
    [
      "security",
      "find-generic-password",
      "-a", account,
      "-s", SERVICE,
      "-w",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    log("get", `No secret found for account: ${account}`);
    return null;
  }
  return stdout.trim();
}

export async function deleteSecret(account: string): Promise<void> {
  log("delete", `Deleting secret for account: ${account}`);
  const proc = Bun.spawn(
    [
      "security",
      "delete-generic-password",
      "-a", account,
      "-s", SERVICE,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  await proc.exited;
  // Ignore errors — secret may not exist
}

/**
 * Get tokens from keychain, with masked versions for display.
 */
export async function getTokens(): Promise<{
  hetzner_api_token: string;
  github_pat: string;
}> {
  const [apiToken, githubPat] = await Promise.all([
    getSecret("hetzner_api_token"),
    getSecret("github_pat"),
  ]);
  return {
    hetzner_api_token: apiToken ?? "",
    github_pat: githubPat ?? "",
  };
}

export function maskToken(token: string): string {
  if (!token || token.length < 8) return token ? "****" : "";
  return token.slice(0, 4) + "..." + token.slice(-4);
}
