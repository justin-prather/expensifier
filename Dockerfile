FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.3.14 AS build
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

RUN bun run build

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/justin-prather/expensifier"
LABEL org.opencontainers.image.description="Self-hosted expense intake, classification, and review"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV APP_DATA_ROOT=/data

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --from=build /app/build ./build

RUN mkdir -p /data && chown -R bun:bun /data

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:3000/api/health/ready'); if (!response.ok) process.exit(1)"]

CMD ["bun", "build/index.js"]
