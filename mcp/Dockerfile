FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER node
ENV MCP_TRANSPORT=http HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
