ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --from=appsource packages/core/src/ocd-storage-client.ts packages/core/src/ocd-storage-client.ts
COPY --from=appsource packages/core/src/storage.ts packages/core/src/storage.ts
COPY --from=appsource packages/core/src/env.ts packages/core/src/env.ts
COPY --from=appsource packages/core/src/public-media.ts packages/core/src/public-media.ts
