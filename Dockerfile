FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/stats.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js db.js ./
COPY public ./public

EXPOSE 8080
CMD ["node", "server.js"]
