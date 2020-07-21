FROM node:12-stretch

COPY app.js package.json package-lock.json ./bot/

WORKDIR /bot

RUN apt update && \
  apt install -y autoconf automake ffmpeg

RUN npm install

ENTRYPOINT ["node", "app.js"]
