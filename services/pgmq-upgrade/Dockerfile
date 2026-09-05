FROM ghcr.io/0-ai-ug/ocd-shared-postgres@sha256:2ef2667194bd9c13fe627e4ac179c47e05168e4999281b77c59c2c1a7fccdcaf
USER root
# PGMQ is SQL-only. Keep the previously tested PostgreSQL and native extensions.
RUN wget -qO- https://github.com/pgmq/pgmq/archive/refs/tags/v1.12.0.tar.gz | tar xz -C /tmp \
    && cp /tmp/pgmq-1.12.0/pgmq-extension/pgmq.control /usr/local/share/postgresql/extension/ \
    && cp /tmp/pgmq-1.12.0/pgmq-extension/sql/pgmq--*.sql /usr/local/share/postgresql/extension/ \
    && cp /tmp/pgmq-1.12.0/pgmq-extension/sql/pgmq.sql /usr/local/share/postgresql/extension/pgmq--1.12.0.sql \
    && rm -rf /tmp/pgmq-1.12.0
USER postgres
