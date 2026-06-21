# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3003
CMD ["node", "server.js"]