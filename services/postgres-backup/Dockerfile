FROM oven/bun:1.4.0-alpine AS bun
FROM postgres:17-alpine
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apk add --no-cache libstdc++ \
    && adduser -D -u 10001 backup
WORKDIR /app
COPY services/postgres-backup/backup.ts services/postgres-backup/archive.ts /app/
USER backup
ENTRYPOINT ["bun", "run", "/app/backup.ts"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=30m \
  CMD bun run /app/backup.ts --health
