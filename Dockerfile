# ── Base image with Node 18 ──────────────────────────────────────────────────
FROM node:18-bookworm-slim

# Install Chromium + dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    xdg-utils \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip downloading its own Chrome (we use the system one)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Rename bundled config → config.defaults so the entrypoint can copy it to
# the Railway persistent volume on first run and symlink /app/config back.
RUN mv /app/config /app/config.defaults \
 && chmod +x /app/entrypoint.sh

# Persistent data lives in a Railway volume mounted at /app/data
# (WhatsApp session + runtime config)
ENV DATA_DIR=/app/data

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
