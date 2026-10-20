FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY feeder.js ./
USER node
CMD ["node", "feeder.js"]
