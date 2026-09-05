FROM oven/bun:1.4.0-alpine
WORKDIR /app
COPY scripts/migrate-object-storage.ts scripts/migrate-object-storage.ts
COPY packages/storage-client/index.ts packages/storage-client/index.ts
COPY services/storage-migration/run.ts run.ts
USER bun
CMD ["bun", "run.ts"]
