#!/usr/bin/env bash
set -euo pipefail

# Bootstrap the panel without Docker: install bun if needed, install deps,
# and run the headless auto-deploy pipeline.
#
# Usage:
#   ./scripts/bootstrap.sh [path/to/panel.json]
#
# Defaults to ./panel.json. Copy example.panel.json and fill it in first.

CONFIG="${1:-panel.json}"

if [ ! -f "$CONFIG" ]; then
  echo "error: config file not found at $CONFIG"
  echo "copy example.panel.json to panel.json and fill in your values."
  exit 1
fi

# Ensure bun is available
if ! command -v bun &>/dev/null; then
  echo "bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# Resolve to absolute path before cd
CONFIG="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"

# Move to repo root (parent of scripts/)
cd "$(dirname "$0")/.."

echo "Installing dependencies..."
bun install --frozen-lockfile

echo "Starting headless bootstrap with config: $CONFIG"
OCD_AUTO_DEPLOY="$CONFIG" exec bun run src/server/index.ts
