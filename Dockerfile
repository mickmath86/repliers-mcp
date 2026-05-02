FROM node:22.12-alpine AS builder

WORKDIR /app
COPY package.json ./
RUN npm install

COPY . .

ENTRYPOINT ["node", "mcpServer.js", "--sse"]