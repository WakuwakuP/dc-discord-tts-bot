const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const  {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ChannelType,
}  = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  getVoiceConnection
} = require("@discordjs/voice");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Readable } = require("stream");

const envs = [
  'DISCORD_TOKEN',
  'DISCORD_GUILD_ID',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'COEFONT_ACCESS_KEY',
  'COEFONT_CLIENT_SECRET',
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
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  COEFONT_ACCESS_KEY,
  COEFONT_CLIENT_SECRET,
} = process.env;

const AFK_CHANNELS = process.env.AFK_CHANNELS.split(',');


// テキスト → ReadableStream
// Cloud Text-to-Speech APIを使用
const GoogleTextToSpeechReadableStream = async (text) => {
  const request = {
    input: { text },
    voice: {
      languageCode: 'ja-JP',
      name: 'ja-JP-Wavenet-A'
    },
    audioConfig: {
      audioEncoding: 'OGG_OPUS',
      speakingRate: 1.2,
      volumeGainDb: -0.2
    }
  };

  const [response] = await client.synthesizeSpeech(request);
  const stream = new Readable({ read() {} });
  stream.push(response.audioContent);

  return stream;
}

/**
 * MemberIdに紐付けたCoefontIdを返す。
 * ない場合は undefined
 * @param {string} memberId 
 * @returns string | undefined
 */
const getCoefontConfig = (memberId) => {
  try {
    const jsonObj = JSON.parse(fs.readFileSync('./config/coefont.json', 'utf8'));
    const index = jsonObj.findIndex(obj => obj.id == memberId)
    const defaultIndex = jsonObj.findIndex(obj => obj.id == 'default')
    if (index != -1) {
      return jsonObj[index];
    }
    if (defaultIndex != -1) {
      return jsonObj[defaultIndex];
    }
    return undefined;
  } catch(error) {
    console.log('/config/coefont.json not found');
    return undefined;
  }
}

const CoefontTextToSpeechReadableStream = async (text, coefontConfig) => {
  const coefontData = Object.assign(coefontConfig)
  delete coefontConfig.id
  if ('format' in coefontConfig) {
    delete coefontConfig.format
  }

  const data = JSON.stringify({
    text,
    ...coefontData
  });

  const date = String(Math.floor(Date.now() / 1000));

  const signature = crypto
    .createHmac('sha256', COEFONT_CLIENT_SECRET)
    .update(date + data)
    .digest('hex');

  try {
    const response = await axios.post('https://api.coefont.cloud/v1/text2speech', data, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': COEFONT_ACCESS_KEY,
        'X-Coefont-Date': date,
        'X-Coefont-Content': signature,
      },
      responseType: 'stream',
    });
    return response.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.log(`CoeFont: ${err.response.status}: ${err.response.statusText}`)
    }
    return undefined;
  }
}

const client = new textToSpeech.TextToSpeechClient({
  credentials: {
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  }
});

const textChannelCreate = async (voiceChannel, voiceJoinedMember) => {
  try {
    const guild = voiceChannel.guild;
    // チャンネル名の後ろにボイスチャンネルのIDを付与して一意に
    let chName = CHANNEL_PREFIX + voiceChannel.name + "_" + voiceChannel.id;
    let botRole = guild.members.me;
    let result = await guild.channels.create({
      name: chName,
      parent: voiceChannel.parent,
      type: ChannelType.GuildText,
      // denyでeveryoneユーザは見れないように
      // allowでボイスチャンネルに参加したメンバーは見れるように
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.CreateInstantInvite,
          ],
        },
        {
          id: voiceJoinedMember.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
          ],
        },
        {
          id: botRole.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
          ],
        }
      ],
    });
    CHANNEL_ID_LIST.push(result.id);
    return result;
  } catch (err) {
    console.log(err);
  }
}

const channelFind = async (voiceChannel) => {
  const guild = voiceChannel.guild;
  const searchCondition = voiceChannel.id;
  const result = guild.channels.cache.find(val => val.name.endsWith(searchCondition));
  return result;
}

const textChannelDelete = async (ch) => {
  const target = await channelFind(ch);
  if (target != null) {
    CHANNEL_ID_LIST = CHANNEL_ID_LIST.filter(id => id !== target.id);
    target.delete().catch(console.error);
  } else {
    console.log("削除するチャンネルがないンゴ");
  }
}

const channelJoin = async (ch, user) => {
  const target = await channelFind(ch);
  if (target != null) {
    target.permissionOverwrites.edit(user, { ViewChannel: true });
    return target;
  } else {
    console.log("チャンネルがないンゴ");
  }
}

const channelExit = async (ch, user) => {
  const target = await channelFind(ch);
  if (target != null) {
    target.permissionOverwrites.edit(user, { ViewChannel: false });
  } else {
    console.log("チャンネルがないンゴ");
  }
}

const joinChannelSendNotification = async (ch, user) => {
  const target = await channelFind(ch);
  if (target != null) {
    const guild = target.guild;
    const sendChannel = await guild.channels.cache.find(val => val.name === target.name);
    await sendChannel.send(`Join: ${user.displayName}`)
      .catch(console.error);
  }
}

const leaveChannelSendNotification = async (ch, user) => {
  const target = await channelFind(ch);
  if (target != null) {
    const guild = target.guild;
    const sendChannel = await guild.channels.cache.find(val => val.name === target.name);
    await sendChannel.send(`Leave: ${user.displayName}`)
      .catch(console.error);
  }
}

const options = {
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent],
};

const discordClient = new Client(options);

discordClient.on('voiceStateUpdate', async (oldState, newState) => {
  const conn = getVoiceConnection(DISCORD_GUILD_ID)
  if (conn) {
    const vcChannelId = conn.joinConfig.channelId
    if (discordClient.channels.cache.get(vcChannelId).members.size < 2) {
      conn.destroy();
    }
  }

  const newMember = newState.member;
  if (oldState.channelId === newState.channelId) {
    return;
  }
  if (oldState.channelId != null) {
    const oldChannel = oldState.guild.channels.cache.get(oldState.channelId);
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
  if (newState.channelId != null) {

    // AFKに指定してあるチャンネルは何もしない
    if (AFK_CHANNELS.includes(newState.channelId)) {
      return;
    }
    const newChannel = newState.guild.channels.cache.get(newState.channelId);
    if (newChannel.members.size == 1) {
      await textChannelCreate(newChannel, newState.member);
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
discordClient.on('messageCreate', async (message) => {
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
    .replace(/https?:\/\/\S+/g, '')     // URL 削除
    .replace(/<@!?\d+>/g, '')           // User 削除
    .replace(/<#\d+>/g, '')             // Channel 削除
    .replace(/<@&\d+>/g, '')            // Role 削除
    .replace(/<a?:.*?:\d+>/g, '')       // 絵文字・カスタム絵文字を除去
    .slice(0, 200);                    // 200文字以内にする

  console.log(`[messageCreate] ${message.member.displayName}: ${message.content}`);

  // テキストが空なら何もしない
  if (!text) { return; }

  // 誰もいなかったら参加しない
  if (channel.members.size < 1) { return; }


  // 発言者の参加チャンネルが、
  // 今のBot参加チャンネルと違うなら移動する
  const currentConnection = getVoiceConnection(DISCORD_GUILD_ID);
  const shouldMove = !currentConnection || currentConnection.joinConfig.channelId !== channel.id;
  const joinOption = {
    adapterCreator: channel.guild.voiceAdapterCreator,
    channelId: channel.id,
    guildId: channel.guild.id,
    selfDeaf: true,
    selfMute: false,
  }
  const conn = shouldMove ? await joinVoiceChannel(joinOption) : currentConnection;
  const player = createAudioPlayer()
  conn.subscribe(player);
  const coefontConfig = getCoefontConfig(message.member.id)

  if (coefontConfig == undefined) {
    const resource = createAudioResource(
      await GoogleTextToSpeechReadableStream(text),
      { inputType: StreamType.OggOpus }
    )
    player.play(resource)
    return;
  }
  const readable = await CoefontTextToSpeechReadableStream(text, coefontConfig);

  if (readable == undefined) {
    const resource = createAudioResource(
      await GoogleTextToSpeechReadableStream(text),
      { inputType: StreamType.OggOpus }
    )
    player.play(resource)
    return;
  }
  const resource = createAudioResource(
    readable,
    { inputType: StreamType.Arbitrary }
  )

  player.play(resource);
});

discordClient.once('ready', () => {
  console.log('ready......');
});

discordClient.login(DISCORD_TOKEN);
