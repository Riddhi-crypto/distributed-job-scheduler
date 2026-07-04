# Build context is the REPO ROOT (see docker-compose.yml) so this image can also
# see db/schema.sql + db/seed.sql for the one-shot migrate service.
FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY backend/package*.json ./
RUN npm install --omit=dev

# App source.
COPY backend/ ./

# migrate.js resolves the SQL at ../../db => /db. Make it available.
COPY db/ /db/

EXPOSE 4000
CMD ["node", "src/index.js"]
