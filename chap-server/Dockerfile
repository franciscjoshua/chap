FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "server.mjs"]
