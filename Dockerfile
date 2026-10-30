FROM node:26.13.0-slim
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc && npm prune --omit=dev
ENV DB_PATH=/data/newsletters.db PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "dist/server.js"]
