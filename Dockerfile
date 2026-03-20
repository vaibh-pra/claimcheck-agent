FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy source
COPY core.ts   ./
COPY server.ts ./
COPY client.js ./
COPY agent.json ./

# Install tsx for running TypeScript directly
RUN npm install tsx typescript

EXPOSE 4000

ENV PORT=4000

CMD ["npx", "tsx", "server.ts"]
