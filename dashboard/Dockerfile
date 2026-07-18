# syntax=docker/dockerfile:1

# ---- build stage: produce static SPA bundle ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY dashboard/package.json ./dashboard/package.json

# Install just the dashboard workspace (+ root) — skips the backend's deps.
RUN npm ci --workspace=@applyt/dashboard --include-workspace-root

COPY dashboard ./dashboard
# dashboard/tailwind.config.cjs requires ../shared/tailwind-tokens.cjs — the
# design tokens shared with the extension popup — so it must be present
# before the build step below.
COPY shared ./shared
# API_BASE defaults to '/api' (see dashboard/src/api.ts); nginx proxies it to
# the backend, so no build-time backend URL is baked in.
RUN npm run build --workspace=@applyt/dashboard

# ---- runtime stage: nginx serves the SPA + proxies /api ----
FROM nginx:1.27-alpine AS runtime
COPY dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dashboard/dist /usr/share/nginx/html
EXPOSE 80
