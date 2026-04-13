FROM oven/bun:1.3.5 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
RUN bun build src/web/index.html --outdir=src/web/dist
RUN bun build src/cli/main.ts --compile --target=bun-linux-x64 --outfile=dist/cli/ocd-linux-x64 \
 && bun build src/cli/main.ts --compile --target=bun-linux-arm64 --outfile=dist/cli/ocd-linux-arm64 \
 && bun build src/cli/main.ts --compile --target=bun-darwin-x64 --outfile=dist/cli/ocd-darwin-x64 \
 && bun build src/cli/main.ts --compile --target=bun-darwin-arm64 --outfile=dist/cli/ocd-darwin-arm64 \
 && bun build src/cli/main.ts --compile --target=bun-windows-x64 --outfile=dist/cli/ocd-windows-x64.exe

FROM oven/bun:1.3.5-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app .
ENV NODE_ENV=production PORT=3001 OCD_DATA_DIR=/app/data
RUN mkdir -p /app/data
EXPOSE 3001
CMD ["bun", "run", "src/server/index.ts"]
