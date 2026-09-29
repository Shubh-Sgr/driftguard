# Two stages: build the TypeScript, then ship only the compiled JS and production deps.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Never run as root.
USER node
# Default: the MCP server on stdio. Any CLI command works too, e.g. `docker run ... diff`.
# Configure with SOURCE_DATABASE_URL / TARGET_DATABASE_URL (read-only credentials).
# Note: `shadow` needs a Docker daemon, so run that command from the host CLI instead.
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["mcp"]
