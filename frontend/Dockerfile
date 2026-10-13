FROM node:22-bookworm AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:frontend

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/public /usr/share/nginx/html/dashboard
EXPOSE 80
