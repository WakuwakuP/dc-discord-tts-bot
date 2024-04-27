const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ChannelType,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  getVoiceConnection,
} = require("@discordjs/voice");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Readable } = require("stream");

const envs = [
  "DISCORD_TOKEN",
  "DISCORD_GUILD_ID",
  "GOOGLE_CLIENT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
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
} = process.env;

const AFK_CHANNELS = process.env.AFK_CHANNELS.split(",");

// テキスト → ReadableStream
// Cloud Text-to-Speech APIを使用
const GoogleTextToSpeechReadableStream = async (text) => {
  const request = {
    input: { text },
    voice: {
      languageCode: "ja-JP",
      name: "ja-JP-Neural2-B",
    },
    audioConfig: {
      audioEncoding: "OGG_OPUS",
      speakingRate: 1.2,
    },
  };

  const [response] = await client.synthesizeSpeech(request);
  const stream = new Readable({ read() {} });
  stream.push(response.audioContent);

  return stream;
};

const client = new textToSpeech.TextToSpeechClient({
  credentials: {
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
});

/**
 * テキストチャンネルを作成する関数です。
 *
 * @param {VoiceChannel} voiceChannel - ボイスチャンネルオブジェクト
 * @param {GuildMember} voiceJoinedMember - ボイスチャンネルに参加したメンバーオブジェクト
 * @returns {Promise<GuildTextChannel>} - 作成されたテキストチャンネルオブジェクトのPromise
 */
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
          allow: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: botRole.id,
          allow: [PermissionsBitField.Flags.ViewChannel],
        },
      ],
    });
    CHANNEL_ID_LIST.push(result.id);
    console.log(`CREATE    : created text channel #${chName}(${result.id})`);
    return result;
  } catch (err) {
    console.log(err);
  }
};

/**
 * 指定されたボイスチャンネルを検索します。
 *
 * @param {VoiceChannel} voiceChannel - 検索対象のボイスチャンネル
 * @returns {Channel} - 検索結果のチャンネル
 */
const channelFind = async (voiceChannel) => {
  const guild = voiceChannel.guild;
  const searchCondition = voiceChannel.id;
  const result = guild.channels.cache.find((val) =>
    val.name.endsWith(searchCondition)
  );
  return result;
};

/**
 * テキストチャンネルを削除します。
 *
 * @param {string} ch - 削除するチャンネルの名前。
 * @returns {Promise<void>} - チャンネルが削除された時に解決される Promise。
 */
const textChannelDelete = async (ch) => {
  const target = await channelFind(ch);
  try {
    if (target != null) {
      CHANNEL_ID_LIST = CHANNEL_ID_LIST.filter((id) => id !== target.id);
      await target.delete();
      console.log(
        `DELETE    : deleted text channel #${target.name}(${target.id})`
      );
    } else {
      console.log("no channels to delete.");
    }
  } catch (err) {
    console.log("API no channels to delete.\n" + err);
  }
};

/**
 * チャンネルを入室時に呼ぶ、ユーザーにチャンネルの表示権限を付与します。
 *
 * @param {Channel} ch - 参加するチャンネル。
 * @param {User} user - 権限を付与するユーザー。
 * @returns {Promise<void>} - 操作が完了したときに解決されるプロミス。
 */
const channelJoin = async (ch, user) => {
  const target = await channelFind(ch);
  if (target != null) {
    target.permissionOverwrites.edit(user, { ViewChannel: true });
  } else {
    console.log("チャンネルがないンゴ");
  }
  console.log(
    `PERMISSION: added view channel #${target.name}(${target.id}) to ${user.displayName}(${user.id})`
  );
};

/**
 * チャンネルを退出時に呼ぶ、ユーザーの権限を更新します。
 *
 * @param {Channel} ch - 退出するチャンネル。
 * @param {User} user - 権限を更新するユーザー。
 * @returns {Promise<void>} - 操作が完了したときに解決されるプロミス。
 */
const channelLeave = async (ch, user) => {
  const target = await channelFind(ch);
  if (target != null) {
    target.permissionOverwrites.edit(user, { ViewChannel: false });
  } else {
    console.log("チャンネルがないンゴ");
  }
  console.log(
    `PERMISSION: deleted view channel #${target.name}(${target.id}) to ${user.displayName}(${user.id})`
  );
};

/**
 * ユーザーがチャンネルに参加したときに通知を送信します。
 *
 * @param {string} ch - チャンネル名。
 * @param {object} user - ユーザーオブジェクト。
 * @returns {Promise<void>} - 通知が送信されると解決するプロミス。
 */
const joinChannelSendNotification = async (ch, user) => {
  const target = await channelFind(ch);
  if (target != null) {
    const guild = target.guild;
    const sendChannel = await guild.channels.cache.find(
      (val) => val.name === target.name
    );
    await sendChannel.send(`Join: ${user.displayName}`).catch(console.error);
    console.log(
      `JOIN      : ${user.displayName} joined channel #${sendChannel.name}(${sendChannel.id})`
    );
  }
};

/**
 * チャンネルから退出したときに通知を送信します。
 *
 * @param {string} ch - チャンネル名
 * @param {object} user - 退出したユーザーのオブジェクト
 * @returns {Promise<void>}
 */
const leaveChannelSendNotification = async (ch, user) => {
  const target = await channelFind(ch);
  if (target != null) {
    const guild = target.guild;
    const sendChannel = await guild.channels.cache.find(
      (val) => val.name === target.name
    );
    await sendChannel.send(`Leave: ${user.displayName}`).catch(console.error);
    console.log(
      `LEAVE     : ${user.displayName} leaved channel #${sendChannel.name}(${sendChannel.id})`
    );
  }
};

const options = {
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
};

const discordClient = new Client(options);

discordClient.on("voiceStateUpdate", async (oldState, newState) => {
  const conn = getVoiceConnection(DISCORD_GUILD_ID);
  if (conn) {
    const vcChannelId = conn.joinConfig.channelId;
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

    if (newMember.user.bot !== true) {
      await leaveChannelSendNotification(oldChannel, oldState.member);
    }
    if (oldChannel.members.size == 0) {
      await textChannelDelete(oldChannel);
    } else {
      if (newMember.user.bot !== true) {
        await channelLeave(oldChannel, newState.member);
      }
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
discordClient.on("messageCreate", async (message) => {
  const guild = message.guild;
  const channel = message.member.voice.channel;

  // ミュートの人の特定テキストチャンネルの発言だけ拾う
  if (
    !message.member.voice.selfMute ||
    guild.id !== DISCORD_GUILD_ID ||
    !channel ||
    !CHANNEL_ID_LIST.includes(message.channel.id)
  ) {
    return;
  }

  const text = message.content
    .replace(/https?:\/\/\S+/g, "") // URL 削除
    .replace(/<@!?\d+>/g, "") // User 削除
    .replace(/<#\d+>/g, "") // Channel 削除
    .replace(/<@&\d+>/g, "") // Role 削除
    .replace(/<a?:.*?:\d+>/g, "") // 絵文字・カスタム絵文字を除去
    .slice(0, 200); // 200文字以内にする

  // テキストが空なら何もしない
  if (!text) {
    return;
  }

  // 誰もいなかったら参加しない
  if (channel.members.size < 1) {
    return;
  }

  console.log(`TTS_LOG  : ${message.member.displayName}: ${message.content}`);

  // 発言者の参加チャンネルが、
  // 今のBot参加チャンネルと違うなら移動する
  const currentConnection = getVoiceConnection(DISCORD_GUILD_ID);
  const shouldMove =
    !currentConnection || currentConnection.joinConfig.channelId !== channel.id;
  const joinOption = {
    adapterCreator: channel.guild.voiceAdapterCreator,
    channelId: channel.id,
    guildId: channel.guild.id,
    selfDeaf: true,
    selfMute: false,
  };
  const conn = shouldMove
    ? await joinVoiceChannel(joinOption)
    : currentConnection;
  const player = createAudioPlayer();
  conn.subscribe(player);

  const resource = createAudioResource(
    await GoogleTextToSpeechReadableStream(text),
    { inputType: StreamType.OggOpus }
  );
  player.play(resource);
});

discordClient.once("ready", () => {
  console.log("ready......");
});

discordClient.login(DISCORD_TOKEN);
