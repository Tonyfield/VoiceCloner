# ---------- build frontend ----------
FROM node:24-slim AS client
WORKDIR /build/client
COPY client/package*.json ./
RUN npm install
COPY client ./
RUN npm run build

# ---------- build backend ----------
FROM node:24-slim AS server
WORKDIR /build/server
COPY server/package*.json ./
RUN npm install
COPY server ./
RUN npm run build

# ---------- runtime ----------
# node:sqlite (内置 SQLite) 在 Node 22.5+ 提供；24 无需 --experimental-sqlite。
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data LOG_DIR=/app/log CLIENT_DIST=/app/client/dist
COPY --from=server /build/server/node_modules ./node_modules
COPY --from=server /build/server/dist ./dist
COPY --from=server /build/server/package.json ./package.json
COPY --from=client /build/client/dist ./client/dist
VOLUME ["/app/data", "/app/log"]
EXPOSE 3000
CMD ["node", "dist/main.js"]