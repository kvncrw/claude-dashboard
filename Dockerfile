FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY server.js ./
COPY public/ ./public/

EXPOSE 3391

ENV PORT=3391 \
    CLAUDE_DIR=/data/.claude

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:3391/healthz || exit 1

USER node

CMD ["node", "server.js"]
