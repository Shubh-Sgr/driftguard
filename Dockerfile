# Two stages: build the TypeScript, then ship only the compiled JS and production deps.
# The build stage runs on the builder's own platform: its output (JS, plus libpg-query's
# WASM; no native addons) is the same on every architecture. The final stage only copies
# files, so building the arm64 image on an amd64 runner needs no CPU emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE NOTICE ./
# Never run as root.
USER node
# Default: the MCP server on stdio. Any CLI command works too, e.g. `docker run ... diff`.
# Configure with SOURCE_DATABASE_URL / TARGET_DATABASE_URL (read-only credentials).
# Note: `shadow` needs a Docker daemon, so run that command from the host CLI instead.
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["mcp"]
