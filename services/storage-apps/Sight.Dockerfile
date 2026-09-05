ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --from=appsource src/server/engine/artifacts/config.ts src/server/engine/artifacts/config.ts
COPY --from=appsource src/server/engine/artifacts/ocd-client.ts src/server/engine/artifacts/ocd-client.ts
