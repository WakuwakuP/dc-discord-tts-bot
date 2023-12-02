FROM node:18

WORKDIR /bot

RUN apt update && \
  apt install -y autoconf automake ffmpeg
COPY package.json package-lock.json /bot/
RUN npm install
COPY app.js /bot/

ENTRYPOINT ["node", "app.js"]
