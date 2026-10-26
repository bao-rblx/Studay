# syntax=docker/dockerfile:1
# Small official Node 22 LTS image on Alpine (~50 MB base vs ~400 MB for node:22).
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies change rarely: copy only the manifests first so this layer
# stays cached until package.json / package-lock.json change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Source code changes on every commit: copy it last.
COPY --chown=node:node . .

# Do not run as root inside the container.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/api/health || exit 1

CMD ["node", "server.js"]
