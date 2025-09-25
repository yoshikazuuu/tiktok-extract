# Dockerfile for tt-fetch (Node.js/Bun)
FROM oven/bun:latest

WORKDIR /app
COPY . .
RUN bun install
CMD ["bun", "src/index.ts"]
