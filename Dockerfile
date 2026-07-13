FROM oven/bun:1.3.5 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY scripts/ scripts/
RUN bun build src/web/index.html --outdir=src/web/dist
RUN bun run scripts/build-cli.ts

FROM oven/bun:1.3.5-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app .
ENV NODE_ENV=production PORT=3001 OCD_DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1
CMD ["bun", "run", "src/server/index.ts"]
