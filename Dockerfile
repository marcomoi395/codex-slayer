FROM node:22-bookworm AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm run camoufox:fetch

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /root/.cache/camoufox /root/.cache/camoufox

EXPOSE 3000
CMD ["node", "dist/main.js"]
