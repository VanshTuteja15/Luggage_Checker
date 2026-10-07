# syntax=docker/dockerfile:1
# ------------------------------------------------------------------
# LuggageTracker worker. Build from the REPOSITORY ROOT (the worker
# bundles the shared engine in src/lib/engine):
#
#   docker build -f worker/Dockerfile -t luggage-tracker-worker .
#   docker run --env-file worker/.env -p 8787:8787 luggage-tracker-worker
# ------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./worker/
RUN cd worker && npm ci --no-audit --no-fund
COPY src/lib ./src/lib
COPY worker/src ./worker/src
COPY worker/build.mjs worker/tsconfig.json ./worker/
RUN cd worker && node build.mjs

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/worker/dist ./dist
USER node
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
