# Dockerfile for tt-fetch (Node.js/Bun)
FROM oven/bun:latest

# Install Python and pip for yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp with --break-system-packages flag
RUN pip3 install -U yt-dlp --break-system-packages

WORKDIR /app
COPY . .
RUN bun install
CMD ["bun", "src/index.ts"]
