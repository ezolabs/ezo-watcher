# Build the web bundle and the one-file server, then run them on a slim Node image.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The config and the data live on a volume (compose.yaml mounts .watcher); nothing secret is baked into the image.
ENV WATCHER_CONFIG=/app/.watcher/config.json
ENV WATCHER_DATA_DIR=/app/.watcher/data
ENV WATCHER_HOST=0.0.0.0
ENV WATCHER_PORT=7717
EXPOSE 7717
CMD ["node", "dist/server/main.mjs"]
