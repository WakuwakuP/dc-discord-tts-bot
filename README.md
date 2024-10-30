# dc-discord-tts-bot

## Overview

VC専用プライベートチャット & 読み上げBot

Google Cloud text-to-speech API

https://github.com/user-attachments/assets/e9c8fcda-f88a-42cb-ab7c-225c51fbfe2c

https://github.com/user-attachments/assets/73bb7ac4-0db0-4484-b16d-5a8e84b61761

## Installation

### get source

```shell
git clone https://github.com/wakuwakup/dc-discord-tts-bot.git
cd dc-discord-tts-bot
```

### Configuration

```shell
cp .env.example .env
vi .env
```
Coefontを使う場合は追加で編集

```shell
cp ./docker/bot/config/coefont.json.example ./docker/bot/config/coefont.json
vi coefont.json
```

### Run

```shell
docker-compose build
docker-compose up -d
```

### Stop

```shell
docker-compose down
```1
