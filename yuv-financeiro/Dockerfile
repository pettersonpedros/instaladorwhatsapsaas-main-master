FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3080 DATA_DIR=/data TZ=America/Sao_Paulo
VOLUME /data
EXPOSE 3080
CMD ["node", "server/index.js"]
