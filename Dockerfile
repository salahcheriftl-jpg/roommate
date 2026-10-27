# ROOMMATE with the LIVE browser (real Chromium on the server).
# Works on Render ("Docker" runtime), Railway, Fly.io, or any machine with Docker.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# use the system Chromium instead of letting puppeteer download its own
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
