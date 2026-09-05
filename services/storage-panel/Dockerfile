# Extend the inspected live panel artifact without publishing concurrent work
# from the operator's checkout. Refresh the base after every panel release.
FROM ghcr.io/0-ai-ug/open-cli-deployment@sha256:2fb15c5dbc611fb2eb0820fa091ecfc1796046722a9e0e57405b557847c635bc
USER root
COPY src/engine/object-storage/presign.ts /app/src/engine/object-storage/presign.ts
COPY src/server/routes/storage-access.ts /app/src/server/routes/storage-access.ts
COPY src/cli/commands/storage.ts /app/src/cli/commands/storage.ts
COPY services/storage-panel/install.ts /tmp/install-storage.ts
RUN bun /tmp/install-storage.ts && bun run scripts/build-cli.ts && rm /tmp/install-storage.ts
USER bun
