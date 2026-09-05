FROM ghcr.io/0-ai-ug/ocd-storage-apps@sha256:0b3822f5f8afcec5ab2bc322349e4ad1794d87ce90ba6f126e140ad04738473e
COPY --from=appsource services/web/provision-db-roles.ts services/web/provision-db-roles.ts
