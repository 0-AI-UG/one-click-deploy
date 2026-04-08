FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
RUN bun build src/web/index.html --outdir=src/web/dist

FROM oven/bun:1-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app .
ENV NODE_ENV=production PORT=3001 OCD_DATA_DIR=/app/data
RUN mkdir -p /app/data
EXPOSE 3001
CMD ["bun", "run", "src/server/index.ts"]
