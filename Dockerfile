FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY core.ts    ./
COPY proxy.ts   ./
COPY agent.js   ./
COPY agent.json ./

RUN npm install tsx typescript

EXPOSE 4001

ENV PROXY_PORT=4001

CMD ["npx", "tsx", "proxy.ts"]
