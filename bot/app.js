const Discord = require("discord.js");
const textToSpeech = require('@google-cloud/text-to-speech');
const { Readable } = require('stream');

// 環境変数

const envs = [
  'DISCORD_TOKEN',
  'DISCORD_GUILD_ID',
  'DISCORD_SOURCE_CHANNEL_ID',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY'
];

let lacksEnv = false;
for (const envName of envs) {
  if (!process.env[envName]) {
    lacksEnv = true;
    console.error(`env variable not found: ${envName}`);
  }
}

if (lacksEnv) {
  process.exit(1);
}

const CHANNEL_PREFIX = "🔑";

let CHANNEL_ID_LIST = [];

const {
  DISCORD_TOKEN,
  DISCORD_GUILD_ID,
  DISCORD_SOURCE_CHANNEL_ID,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY
} = process.env;

// テキスト → ReadableStream
// Cloud Text-to-Speech APIを使用
async function textToSpeechReadableStream(text) {
  const request = {
    input: { text },
    voice: {
      languageCode: 'ja-JP',
      name: 'ja-JP-Wavenet-A'
    },
    audioConfig: {
      audioEncoding: 'OGG_OPUS',
      speakingRate: 1.2
    }
  };

  const [response] = await client.synthesizeSpeech(request);
  const stream = new Readable({ read() { } });
  stream.push(response.audioContent);

  return stream;
}

const client = new textToSpeech.TextToSpeechClient({
  credentials: {
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  }
});

async function textChannelCreate(voiceChannel, voiceJoinedMember) {
  try {
    const guild = voiceChannel.guild;
    // チャンネル名の後ろにボイスチャンネルのIDを付与して一意に
    let chName = CHANNEL_PREFIX + voiceChannel.name + "_" + voiceChannel.id;
    let botRole = guild.me;
    let result = await guild.channels.create(chName, {
      parent: voiceChannel.parent,
      type: "text",
      // denyでeveryoneユーザは見れないように
      // allowでボイスチャンネルに参加したメンバーは見れるように
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY", "CREATE_INSTANT_INVITE"]
        },
        {
          id: voiceJoinedMember.id,
          allow: ["VIEW_CHANNEL"]
        },
        {
          id: botRole.id,
          allow: ["VIEW_CHANNEL"]
        }
      ],
    });
    CHANNEL_ID_LIST.push(result.id);
    return result;
  } catch (err) {
    console.log(err);
  }
}
async function channelFind(voiceChannel) {
  const guild = voiceChannel.guild;
  const searchCondition = voiceChannel.id;
  const result = guild.channels.cache.find(val => val.name.endsWith(searchCondition));
  return result;
}
async function textChannelDelete(ch) {
  const target = await channelFind(ch);
  if (target != null) {
    CHANNEL_ID_LIST = CHANNEL_ID_LIST.filter(id => id !== target.id);
    target.delete().catch(console.error);
  } else {
    console.log("削除するチャンネルがないンゴ");
  }
}
async function channelJoin(ch, user) {
  const target = await channelFind(ch);
  if (target != null) {
    target.updateOverwrite(user, { VIEW_CHANNEL: true });
    return target;
  } else {
    console.log("チャンネルがないンゴ");
  }
}
async function channelExit(ch, user) {
  const target = await channelFind(ch);
  if (target != null) {
    target.updateOverwrite(user, { VIEW_CHANNEL: false });
  } else {
    console.log("チャンネルがないンゴ");
  }
}
async function joinChannelSendNotification(ch, user) {
  const target = await channelFind(ch);
  const guild = target.guild;
  const sendChannel = await guild.channels.cache.find(val => val.name === target.name);
  await sendChannel.send(`Join: <@!${user.id}>`)
    .catch(console.error);
}

async function leaveChannelSendNotification(ch, user) {
  const target = await channelFind(ch);
  const guild = target.guild;
  const sendChannel = await guild.channels.cache.find(val => val.name === target.name);
  await sendChannel.send(`Leave: <@!${user.id}>`)
    .catch(console.error);
}

(async function main() {
  const discordClient = new Discord.Client({
    messageCacheMaxSize: 20,
    messageSweepInterval: 30
  });

  // Botだけになったらチャンネルから落ちる
  discordClient.on('voiceStateUpdate', (oldState, newState) => {
    const conn = discordClient.voice.connections.get(DISCORD_GUILD_ID);
    if (conn && conn.channel && conn.channel.members.array().length < 2) {
      conn.disconnect();
    }
  });

  discordClient.on('voiceStateUpdate', async (oldState, newState) => {
    const newMember = newState.member;
    if (oldState.channelID === newState.channelID) {
      return;
    }
    if (oldState.channelID != null) {
      const oldChannel = oldState.guild.channels.cache.get(oldState.channelID);
      if (oldChannel.members.size == 0) {
        await textChannelDelete(oldChannel);
      } else {
        if (newMember.user.bot !== true) {
          await channelExit(oldChannel, newState.member);
        }
      }

      if (newMember.user.bot !== true) {
        await leaveChannelSendNotification(oldChannel, oldState.member);
      }
    }
    if (newState.channelID != null) {
      const newChannel = newState.guild.channels.cache.get(newState.channelID);
      if (newChannel.members.size == 1) {
        textChannel = await textChannelCreate(newChannel, newState.member);
      } else {
        if (newMember.user.bot !== true) {
          await channelJoin(newChannel, newState.member);
        }
      }
      if (newMember.user.bot !== true) {
        await joinChannelSendNotification(newChannel, newState.member);
      }
    }
  });


  // ソースとなるテキストチャンネルで発言があった場合、
  // ボイスチャンネルに参加して発言する
  discordClient.on('message', async (message) => {
    const guild = message.guild;
    const channel = message.member.voice.channel;

    // ミュートの人の特定テキストチャンネルの発言だけ拾う
    if (
      !message.member.voice.selfMute || guild.id !== DISCORD_GUILD_ID ||
      !channel || !CHANNEL_ID_LIST.includes(message.channel.id)
    ) {
      return;
    }

    const text = message
      .content
      .replace(/https?:\/\/\S+/g, '')
      .replace(/<a?:.*?:\d+>/g, '')   // カスタム絵文字を除去
      .slice(0, 50);

    // テキストが空なら何もしない
    if (!text) { return; }

    // 誰もいなかったら参加しない
    if (channel.members.array().length < 1) { return; }

    // 発言者の参加チャンネルが、
    // 今のBot参加チャンネルと違うなら移動する
    const currentConnection = discordClient.voice.connections.get(DISCORD_GUILD_ID);
    const shouldMove = !currentConnection || currentConnection.channel.id !== channel.id;
    const conn = shouldMove ? await channel.join() : currentConnection;

    conn.play(await textToSpeechReadableStream(text), { highWaterMark: 6, bitrate: 'auto' });
  });

  discordClient.once('ready', () => {
    console.log('Connected to Discord successfully!');
  });

  discordClient.login(DISCORD_TOKEN);
})().catch((e) => console.error(e));
