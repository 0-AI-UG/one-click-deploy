FROM ghcr.io/0-ai-ug/open-cli-deployment@sha256:5ced6c57ae99ce4b9810212f1e31a76ef98791243ebccf2016f94fca3b34ed28
USER root
COPY services/storage-panel/install-server-address.ts /tmp/install-server-address.ts
RUN bun /tmp/install-server-address.ts && rm /tmp/install-server-address.ts
USER bun
