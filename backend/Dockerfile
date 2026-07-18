# syntax=docker/dockerfile:1

# ---- build stage: install deps + compile TS ----
# Native module (better-sqlite3) usually installs a prebuilt binary; build
# toolchain is present as a fallback so `npm ci` never fails to compile it.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy only manifests first for better layer caching.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY dashboard/package.json ./dashboard/package.json

# Install just the backend workspace (+ root) — skips the dashboard's deps.
RUN npm ci --workspace=@applyt/backend --include-workspace-root

# Compile, then drop dev dependencies so we can copy a lean node_modules.
COPY backend ./backend
RUN npm run build --workspace=@applyt/backend \
  && npm prune --omit=dev --workspace=@applyt/backend --include-workspace-root

# ---- runtime stage: prod deps + compiled JS only ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317

# Run as the built-in non-root user shipped in the node image.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /app/package.json ./package.json

# SQLite lives here; docker-compose mounts a named volume over it.
RUN mkdir -p /app/backend/data && chown -R node:node /app/backend/data
USER node

EXPOSE 4317
CMD ["node", "backend/dist/index.js"]
