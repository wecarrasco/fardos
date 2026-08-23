# ---- build ------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 is a native module; these are needed only if no prebuilt
# binary matches the platform, which is why they stay out of the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Reinstall with dev dependencies pruned, so only runtime deps are copied over.
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

# Where the SQLite file lives. Mount a volume here to survive redeploys.
ENV DB_PATH=/data/mtg.db
RUN mkdir -p /data

EXPOSE 3000
# The app serves before it has data, showing "press Update now", so a plain
# process check is the right readiness signal.
CMD ["node", "dist/server.js"]
