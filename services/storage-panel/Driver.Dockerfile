FROM ghcr.io/0-ai-ug/open-cli-deployment@sha256:7517a60fb8950e7b716e91d5ea7401828eb38295d67cbdefce2d71b40b1baeb2
USER root
COPY services/storage-panel/install-volume-driver.ts /tmp/install-volume-driver.ts
RUN bun /tmp/install-volume-driver.ts && rm /tmp/install-volume-driver.ts
USER bun
