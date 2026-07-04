# Build context is the REPO ROOT (see docker-compose.yml).
FROM node:20-alpine

WORKDIR /app

COPY worker/package*.json ./
RUN npm install --omit=dev

COPY worker/ ./

# tini gives the worker a proper PID 1 so SIGTERM reaches it and graceful
# shutdown (drain in-flight jobs, mark dead) works on `docker compose stop`.
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/worker.js"]
