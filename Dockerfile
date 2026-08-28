FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /data/pdfs
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node","src/server.js"]
