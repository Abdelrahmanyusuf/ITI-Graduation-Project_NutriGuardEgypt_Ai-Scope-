FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json eslint.config.js ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3000 NODE_OPTIONS="--enable-source-maps --max-old-space-size=512"
WORKDIR /app
RUN addgroup -S nutriguard && adduser -S nutriguard -G nutriguard
COPY --from=build --chown=nutriguard:nutriguard /app/package.json ./package.json
COPY --from=build --chown=nutriguard:nutriguard /app/node_modules ./node_modules
COPY --from=build --chown=nutriguard:nutriguard /app/dist ./dist
USER nutriguard
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "dist/server/start.js"]
