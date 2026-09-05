FROM postgres:17.11-alpine AS build

# with_llvm=no skips JIT bitcode (.bc) generation, which is the only thing that
# needs clang/llvm here. This keeps the build independent of whichever LLVM major
# the current Alpine release ships (pinning clangN/llvmN-dev broke on every Alpine
# bump of the base image). The make command-line override beats pgxs's
# Makefile.global (with_llvm = yes) for pgmq/pgvector and PostGIS alike.
RUN apk add --no-cache \
        build-base cmake autoconf automake libtool \
        gdal-dev geos-dev proj-dev protobuf-c-dev json-c-dev libxml2-dev \
        pcre2-dev perl \
    && wget -qO- https://github.com/postgis/postgis/archive/refs/tags/3.5.2.tar.gz | tar xz \
    && cd postgis-3.5.2 \
    && ./autogen.sh \
    && ./configure --without-raster --without-phony-revision \
    && make -j$(nproc) with_llvm=no \
    && make install with_llvm=no \
    && cd / && rm -rf postgis-3.5.2 \
    && wget -qO- https://github.com/pgmq/pgmq/archive/refs/tags/v1.12.0.tar.gz | tar xz \
    && cd pgmq-1.12.0/pgmq-extension \
    && make -j$(nproc) with_llvm=no \
    && make install with_llvm=no \
    && cd / && rm -rf pgmq-1.12.0

# pgvector (image.crop_embedding for georank re-ranking). Separate layer so the
# slow PostGIS/pgmq build above stays cached when bumping the pgvector version.
RUN wget -qO- https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.1.tar.gz | tar xz \
    && cd pgvector-0.8.1 \
    && make -j$(nproc) with_llvm=no \
    && make install with_llvm=no \
    && cd / && rm -rf pgvector-0.8.1

FROM postgres:17.11-alpine

RUN apk add --no-cache gdal geos proj protobuf-c json-c libxml2

COPY --from=build /usr/local/lib/postgresql/ /usr/local/lib/postgresql/
COPY --from=build /usr/local/share/postgresql/extension/postgis* /usr/local/share/postgresql/extension/
COPY --from=build /usr/local/share/postgresql/extension/pgmq* /usr/local/share/postgresql/extension/
COPY --from=build /usr/local/share/postgresql/extension/vector* /usr/local/share/postgresql/extension/

# Bake the extension-init script into the image so a standalone deploy (no
# compose bind mount) still gets postgis/pgmq/vector on first boot. Compose's
# bind mount of the same path simply shadows this copy.


# Start as the postgres user instead of root: hardened runtimes (OCD runs every
# container with --cap-drop=ALL --security-opt=no-new-privileges) break the
# entrypoint's root-mode chown/su dance. As non-root the official entrypoint
# skips both — the data dir just has to be writable by uid 70 (named volumes
# inherit that from the image; bind mounts need a one-time chown). On ext4
# block volumes set PGDATA to a subdirectory, e.g. /var/lib/postgresql/data/
# pgdata, so initdb doesn't trip over lost+found.
USER postgres
