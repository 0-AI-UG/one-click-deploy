import path from "path";

const ALLOWED_BINARIES = new Set([
  "ocd-linux-x64",
  "ocd-linux-arm64",
  "ocd-darwin-x64",
  "ocd-darwin-arm64",
  "ocd-windows-x64.exe",
]);

const CLI_DIR = path.resolve(import.meta.dir, "../../../dist/cli");

const INSTALL_SH = `#!/bin/sh
set -e

PANEL_URL="{{PANEL_URL}}"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux*)  OS=linux ;;
  Darwin*) OS=darwin ;;
  *)       echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

BINARY="ocd-\${OS}-\${ARCH}"
TMP="/tmp/ocd-download"

echo "Downloading ocd for \${OS}/\${ARCH}..."
curl -fsSL "$PANEL_URL/cli/$BINARY" -o "$TMP"
chmod +x "$TMP"

# Install location
INSTALL_DIR="$HOME/.local/bin"
if [ "$(id -u)" = "0" ]; then
  INSTALL_DIR="/usr/local/bin"
fi
mkdir -p "$INSTALL_DIR"
mv "$TMP" "$INSTALL_DIR/ocd"

echo "Installed ocd to $INSTALL_DIR/ocd"

# Pre-seed config with panel URL
CONFIG_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/ocd"
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  printf '{"panel_url":"%s"}\\n' "$PANEL_URL" > "$CONFIG_DIR/config.json"
  chmod 600 "$CONFIG_DIR/config.json"
fi

# Check PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo ""; echo "Warning: $INSTALL_DIR is not in your PATH."; echo "Add it with: export PATH=\\"$INSTALL_DIR:\\$PATH\\"" ;;
esac

echo ""
echo "Run 'ocd login' to authenticate."
`;

function getPanelUrl(request: Request): string {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "localhost:3001";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

export function handleCliInstallSh(request: Request): Response {
  const panelUrl = getPanelUrl(request);
  const body = INSTALL_SH.replaceAll("{{PANEL_URL}}", panelUrl);
  return new Response(body, {
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
  });
}

export async function handleCliDownload(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const filename = url.pathname.split("/").pop() || "";

  if (!ALLOWED_BINARIES.has(filename)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const filePath = path.join(CLI_DIR, filename);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return Response.json({ error: "Binary not available" }, { status: 404 });
  }

  const displayName = filename.endsWith(".exe") ? "ocd.exe" : "ocd";

  return new Response(file, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${displayName}"`,
    },
  });
}
