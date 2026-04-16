#!/bin/sh
set -e

# ENGINE_WORKERS controls how many dedicated engine processes to spawn
# alongside the server. Default: 0 (server runs its own embedded engine).
#
# Examples:
#   ENGINE_WORKERS=0  → server + embedded engine (single-tenant default)
#   ENGINE_WORKERS=2  → server (no engine) + 2 dedicated engine processes
#   ENGINE_WORKERS=4  → server (no engine) + 4 dedicated engine processes

WORKERS="${ENGINE_WORKERS:-0}"

if [ "$WORKERS" -gt 0 ]; then
  # Disable the server's embedded engine — dedicated workers handle it
  export OCD_ENGINE=0

  echo "[entrypoint] Starting server (engine disabled) + ${WORKERS} engine worker(s)"

  # Start engine workers in background
  i=0
  while [ "$i" -lt "$WORKERS" ]; do
    bun run src/engine/entrypoint.ts &
    i=$((i + 1))
  done

  # Start server in foreground
  exec bun run src/server/index.ts
else
  echo "[entrypoint] Starting server with embedded engine"
  exec bun run src/server/index.ts
fi
