# Node LTS on Alpine. No npm install needed: the app has zero dependencies.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

COPY package.json server.js spotify.js spotify-auth.js ./
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
