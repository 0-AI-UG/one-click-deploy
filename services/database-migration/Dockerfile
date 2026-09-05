FROM ghcr.io/0-ai-ug/ocd-postgres-backup@sha256:1234da893fc0f0dd926fd7fb3c3d4ec34448bb1ae9c1d7dcb937b1805fa49a33
COPY services/database-migration/migrate.ts /app/migrate.ts
ENTRYPOINT []
CMD ["bun", "/app/migrate.ts"]
