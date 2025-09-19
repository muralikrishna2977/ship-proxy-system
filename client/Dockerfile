FROM node:18-slim
WORKDIR /app
COPY client.js package.json ./
EXPOSE 8080
ENV OFFSHORE_HOST=server
ENV OFFSHORE_PORT=9999
CMD ["node", "client.js"]
