# Build context is ./frontend (see docker-compose.yml). Runs the Vite dev server
# with the API proxy pointed at the `api` service inside the Docker network.
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . ./

EXPOSE 5173
# --host binds to 0.0.0.0 so the port is reachable from outside the container.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
