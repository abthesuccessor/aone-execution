# aone-execution in a container.
#
# This image runs the engine and serves the built workbench from one port. The
# Tauri desktop app is NOT in here -- it is a native GUI and has nothing to draw
# on inside a container. What you get is the same engine and the same web UI.
#
# Build:  docker build -t aone-execution .
# Run:    docker run --rm -p 127.0.0.1:4317:4317 \
#           -v aone-execution-data:/data \
#           -v "$PWD":/workspace \
#           aone-execution
# Open:   http://127.0.0.1:4317
#
# Publish to 127.0.0.1 as shown. The engine has no authentication, so binding
# the published port to all interfaces hands it to your whole network.

# ---- build the workbench -----------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /src

# Dependencies first so edits to source do not invalidate the install layer.
COPY package.json package-lock.json ./
COPY apps/local-server/package.json apps/local-server/
COPY apps/workbench/package.json apps/workbench/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci

COPY . .
RUN npm run build:workbench

# ---- runtime -----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# The bundled PostgreSQL binaries are dynamically linked and need ICU and
# readline; the base image carries neither.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libicu72 libreadline8 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only what the engine needs at runtime. This runs inside the Linux
# image, so npm resolves the Linux PostgreSQL package rather than the host's.
COPY package.json package-lock.json ./
COPY apps/local-server/package.json apps/local-server/
COPY apps/workbench/package.json apps/workbench/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --omit=dev --workspace @aone-execution/local-server --include-workspace-root \
 && npm cache clean --force

COPY apps/local-server/src apps/local-server/src
COPY --from=build /src/apps/workbench/dist apps/workbench/dist

# PostgreSQL refuses to run as root, and so should this. /data holds the
# cluster and the object store; /workspace is the project you are working on.
RUN mkdir -p /data /workspace && chown -R node:node /data /workspace /app
USER node

ENV EGE_HOST=0.0.0.0 \
    EGE_PORT=4317 \
    EGE_ALLOW_NON_LOOPBACK_BIND=1 \
    EGE_DATABASE_PATH=/data/postgres \
    EGE_OBJECT_ROOT=/data/object-store \
    EGE_WORKSPACE_ROOT=/workspace \
    EGE_STATIC_ROOT=/app/apps/workbench/dist \
    NODE_ENV=production

VOLUME ["/data", "/workspace"]
EXPOSE 4317

HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/local-server/src/index.mjs"]
