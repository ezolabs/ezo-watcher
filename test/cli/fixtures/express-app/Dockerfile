FROM node:24-slim
WORKDIR /app
COPY . .
RUN npm install --omit=dev
EXPOSE 3000
HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/healthz || exit 1
CMD ["node", "src/server.js"]
