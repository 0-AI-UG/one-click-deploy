ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
COPY --from=appsource packages/server/src/infrastructure/storage/ocd-client.ts packages/server/src/infrastructure/storage/ocd-client.ts
COPY --from=appsource packages/server/src/infrastructure/storage/ocd-storage.ts packages/server/src/infrastructure/storage/ocd-storage.ts
COPY --from=appsource packages/server/src/infrastructure/storage/configured-object-storage.ts packages/server/src/infrastructure/storage/configured-object-storage.ts
COPY services/storage-apps/install-foody.ts /tmp/install-ocd-storage.ts
RUN bun /tmp/install-ocd-storage.ts && rm /tmp/install-ocd-storage.ts
USER bun
