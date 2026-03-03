import {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ChannelType,
  VoiceChannel,
  GuildMember,
  TextChannel,
  Collection,
  VoiceState,
  Message,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  getVoiceConnection,
  VoiceConnection,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  entersState,
} from "@discordjs/voice";
import Keyv from "keyv";
import KeyvSqlite from "@keyv/sqlite";
import textToSpeech from "@google-cloud/text-to-speech";
import { Readable } from "stream";

// Environment variable validation
const envs = [
  "DISCORD_TOKEN",
  "DISCORD_GUILD_ID",
  "GOOGLE_CLIENT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "AFK_CHANNELS",
] as const;

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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID!;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL!;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY!;

const AFK_CHANNELS = process.env.AFK_CHANNELS!.split(",").filter(Boolean);

const channels = new Keyv({
  store: new KeyvSqlite("sqlite://data/db.sqlite"),
  namespace: "channels",
});

const setChannel = async (channelId: string): Promise<boolean> => {
  try {
    return await channels.set(channelId, true);
  } catch (err) {
    console.error(`Error setting channel ${channelId}:`, err);
    throw err;
  }
};

const hasChannel = async (channelId: string): Promise<boolean> => {
  try {
    return await channels.has(channelId);
  } catch (err) {
    console.error(`Error checking channel ${channelId}:`, err);
    return false;
  }
};

const deleteChannel = async (channelId: string): Promise<boolean> => {
  try {
    return await channels.delete(channelId);
  } catch (err) {
    console.error(`Error deleting channel ${channelId}:`, err);
    throw err;
  }
};

const ttsClient = new textToSpeech.TextToSpeechClient({
  credentials: {
    client_email: GOOGLE_CLIENT_EMAIL,
    private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
});

/**
 * テキスト → ReadableStream
 * Cloud Text-to-Speech APIを使用してテキストを音声に変換
 *
 * @param text - 変換するテキスト
 * @returns 音声データのストリーム
 * @throws TTS API呼び出しに失敗した場合
 */
const GoogleTextToSpeechReadableStream = async (
  text: string
): Promise<Readable> => {
  try {
    const request = {
      input: { text },
      voice: {
        languageCode: "ja-JP",
        name: "ja-JP-Neural2-B",
      },
      audioConfig: {
        audioEncoding: "OGG_OPUS" as const,
        speakingRate: 1.2,
      },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    const stream = new Readable({ read() {} });
    if (response.audioContent) {
      stream.push(response.audioContent);
    }
    stream.push(null); // End of stream

    return stream;
  } catch (err) {
    console.error("Error synthesizing speech:", err);
    throw err;
  }
};

/**
 * テキストチャンネルを作成する関数です。
 *
 * @param voiceChannel - ボイスチャンネルオブジェクト
 * @param voiceJoinedMember - ボイスチャンネルに参加したメンバーオブジェクト
 * @returns 作成されたテキストチャンネルオブジェクトのPromise
 */
const textChannelCreate = async (
  voiceChannel: VoiceChannel,
  voiceJoinedMember: GuildMember
): Promise<TextChannel> => {
  try {
    const guild = voiceChannel.guild;
    // チャンネル名の後ろにボイスチャンネルのIDを付与して一意に
    const chName = CHANNEL_PREFIX + voiceChannel.name + "_" + voiceChannel.id;
    const botRole = guild.members.me;
    if (!botRole) {
      throw new Error("Bot member not found in guild");
    }

    const result = await guild.channels.create({
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
    await setChannel(result.id);
    console.log(`CREATE    : created text channel #${chName}(${result.id})`);
    return result as TextChannel;
  } catch (err) {
    console.error("Error creating text channel:", err);
    throw err;
  }
};

/**
 * 指定されたボイスチャンネルに対応するテキストチャンネルを検索します。
 *
 * @param voiceChannel - 検索対象のボイスチャンネル
 * @returns 検索結果のチャンネルコレクション
 */
const channelFind = (
  voiceChannel: VoiceChannel
): Collection<string, TextChannel> => {
  const guild = voiceChannel.guild;
  const searchCondition = voiceChannel.id;
  const result = guild.channels.cache.filter(
    (val): val is TextChannel =>
      val.isTextBased() && !val.isThread() && val.name.endsWith(searchCondition)
  );
  return result as Collection<string, TextChannel>;
};

/**
 * テキストチャンネルを削除します。
 *
 * @param ch - 削除するチャンネル
 * @returns チャンネルが削除された時に解決される Promise
 */
const textChannelDelete = async (ch: VoiceChannel): Promise<void> => {
  try {
    const target = channelFind(ch);

    if (target.size > 0) {
      // Promise.all を使用して並行処理
      await Promise.all(
        target.map(async (channel) => {
          try {
            await deleteChannel(channel.id);
            await channel.delete();
            console.log(
              `DELETE    : deleted text channel #${channel.name}(${channel.id})`
            );
          } catch (err) {
            console.error(`Error deleting channel ${channel.id}:`, err);
          }
        })
      );
    } else {
      console.log("DELETE    : no channels to delete");
    }
  } catch (err) {
    console.error("Error in textChannelDelete:", err);
  }
};

/**
 * チャンネルを入室時に呼ぶ、ユーザーにチャンネルの表示権限を付与します。
 *
 * @param ch - 参加するボイスチャンネル
 * @param user - 権限を付与するユーザー
 * @returns 操作が完了したときに解決されるプロミス
 */
const channelJoin = async (
  ch: VoiceChannel,
  user: GuildMember
): Promise<void> => {
  try {
    const target = channelFind(ch);
    if (target.size > 0) {
      const textChannel = target.first();
      if (!textChannel || !textChannel.permissionOverwrites) {
        return;
      }
      await textChannel.permissionOverwrites.edit(user, { ViewChannel: true });
      console.log(
        `PERMISSION: added view channel #${textChannel.name}(${textChannel.id}) to ${user.displayName}(${user.id})`
      );
    } else {
      console.log(
        `PERMISSION: no text channel found for voice channel ${ch.id}`
      );
    }
  } catch (err) {
    console.error("Error adding channel view permission:", err);
  }
};

/**
 * チャンネルを退出時に呼ぶ、ユーザーの権限を更新します。
 *
 * @param ch - 退出するボイスチャンネル
 * @param user - 権限を更新するユーザー
 * @returns 操作が完了したときに解決されるプロミス
 */
const channelLeave = async (
  ch: VoiceChannel,
  user: GuildMember
): Promise<void> => {
  try {
    const target = channelFind(ch);
    if (target.size > 0) {
      const textChannel = target.first();
      if (!textChannel || !textChannel.permissionOverwrites) {
        return;
      }
      await textChannel.permissionOverwrites.edit(user, { ViewChannel: false });
      console.log(
        `PERMISSION: removed view channel #${textChannel.name}(${textChannel.id}) from ${user.displayName}(${user.id})`
      );
    } else {
      console.log(
        `PERMISSION: no text channel found for voice channel ${ch.id}`
      );
    }
  } catch (err) {
    console.error("Error removing channel view permission:", err);
  }
};

/**
 * ユーザーがチャンネルに参加したときに通知を送信します。
 *
 * @param ch - ボイスチャンネル
 * @param user - ユーザーオブジェクト
 * @returns 通知が送信されると解決するプロミス
 */
const joinChannelSendNotification = async (
  ch: VoiceChannel,
  user: GuildMember
): Promise<void> => {
  try {
    const target = channelFind(ch);
    if (target.size > 0) {
      const sendChannel = target.first();
      if (!sendChannel) {
        return;
      }
      await sendChannel.send(`Join: ${user.displayName}`);
      console.log(
        `JOIN      : ${user.displayName} joined channel #${sendChannel.name}(${sendChannel.id})`
      );
    }
  } catch (err) {
    console.error("Error sending join notification:", err);
  }
};

/**
 * チャンネルから退出したときに通知を送信します。
 *
 * @param ch - ボイスチャンネル
 * @param user - 退出したユーザーのオブジェクト
 * @returns 通知送信完了のPromise
 */
const leaveChannelSendNotification = async (
  ch: VoiceChannel,
  user: GuildMember
): Promise<void> => {
  try {
    const target = channelFind(ch);
    if (target.size > 0) {
      const sendChannel = target.first();
      if (!sendChannel) {
        return;
      }
      await sendChannel.send(`Leave: ${user.displayName}`);
      console.log(
        `LEAVE     : ${user.displayName} left channel #${sendChannel.name}(${sendChannel.id})`
      );
    }
  } catch (err) {
    console.error("Error sending leave notification:", err);
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

discordClient.on("voiceStateUpdate", async (oldState: VoiceState, newState: VoiceState) => {
  try {
    if (!newState.member) {
      return;
    }

    console.log(
      `VOICE_LOG : ${newState.member.id}(${newState.member.displayName}) ${oldState.channelId} -> ${newState.channelId}`
    );

    // ボイスチャンネルの接続管理
    const conn = getVoiceConnection(DISCORD_GUILD_ID);
    if (conn) {
      const vcChannelId = conn.joinConfig.channelId;
      if (vcChannelId) {
        const voiceChannel = discordClient.channels.cache.get(vcChannelId);
        if (voiceChannel && "members" in voiceChannel) {
          const members = voiceChannel.members;
          if (members && "size" in members && members.size < 2) {
            conn.destroy();
          }
        }
      }
    }

    const newMember = newState.member;

    // チャンネル移動がない場合は処理をスキップ
    if (oldState.channelId === newState.channelId) {
      return;
    }

    // ボットの場合は処理をスキップ
    const isBot = newMember.user.bot;

    // 退出処理
    if (oldState.channelId != null && oldState.member) {
      const oldChannel = oldState.guild.channels.cache.get(
        oldState.channelId
      ) as VoiceChannel | undefined;
      if (!oldChannel) {
        console.log(
          `Warning: oldChannel ${oldState.channelId} not found in cache`
        );
        return;
      }

      if (!isBot) {
        await leaveChannelSendNotification(oldChannel, oldState.member);
      }

      if (oldChannel.members.size === 0) {
        if (!isBot) {
          await textChannelDelete(oldChannel);
        }
      } else {
        if (!isBot) {
          await channelLeave(oldChannel, newState.member);
        }
      }
    }

    // 入室処理
    if (newState.channelId != null) {
      // AFKに指定してあるチャンネルは何もしない
      if (AFK_CHANNELS.includes(newState.channelId)) {
        return;
      }

      const newChannel = newState.guild.channels.cache.get(
        newState.channelId
      ) as VoiceChannel | undefined;
      if (!newChannel) {
        console.log(
          `Warning: newChannel ${newState.channelId} not found in cache`
        );
        return;
      }

      if (newChannel.members.size === 1) {
        await textChannelDelete(newChannel);
        await textChannelCreate(newChannel, newState.member);
      } else {
        if (!isBot) {
          await channelJoin(newChannel, newState.member);
        }
      }

      if (!isBot) {
        await joinChannelSendNotification(newChannel, newState.member);
      }
    }
  } catch (err) {
    console.error("Error in voiceStateUpdate event:", err);
  }
});

/**
 * テキストメッセージを処理してTTS音声を再生する
 * ミュート状態のユーザーが特定のテキストチャンネルで発言した場合のみ処理
 */
discordClient.on("messageCreate", async (message: Message) => {
  try {
    // 基本的なバリデーション
    if (!message.guild || !message.member) {
      return;
    }

    const guild = message.guild;
    const member = message.member;
    const channel = member.voice.channel;

    // ミュートの人の特定テキストチャンネルの発言だけ拾う
    if (
      !member.voice.selfMute ||
      guild.id !== DISCORD_GUILD_ID ||
      !channel ||
      !(await hasChannel(message.channel.id))
    ) {
      return;
    }

    // テキストのクリーニング
    const text = message.content
      .replace(/https?:\/\/\S+/g, "") // URL 削除
      .replace(/<@!?\d+>/g, "") // User 削除
      .replace(/<#\d+>/g, "") // Channel 削除
      .replace(/<@&\d+>/g, "") // Role 削除
      .replace(/<a?:.*?:\d+>/g, "") // 絵文字・カスタム絵文字を除去
      .trim()
      .slice(0, 200); // 200文字以内にする

    // テキストが空なら何もしない
    if (!text) {
      return;
    }

    // 誰もいなかったら参加しない
    if (channel.members.size < 1) {
      return;
    }

    console.log(
      `TTS_LOG   : ${member.displayName}: ${message.content}`
    );

    // 発言者の参加チャンネルが、今のBot参加チャンネルと違うなら移動する
    const currentConnection = getVoiceConnection(DISCORD_GUILD_ID);
    const shouldMove =
      !currentConnection ||
      currentConnection.joinConfig.channelId !== channel.id;

    const joinOption = {
      adapterCreator: channel.guild.voiceAdapterCreator,
      channelId: channel.id,
      guildId: channel.guild.id,
      selfDeaf: true,
      selfMute: false,
    };

    const conn: VoiceConnection = shouldMove
      ? joinVoiceChannel(joinOption)
      : currentConnection;

    // 接続がReadyになるまで待つ
    if (conn.state.status !== VoiceConnectionStatus.Ready) {
      try {
        await entersState(conn, VoiceConnectionStatus.Ready, 5_000);
      } catch {
        console.error("TTS_ERROR : VoiceConnection failed to become ready");
        return;
      }
    }

    // TTS音声の生成と再生
    const audioStream = await GoogleTextToSpeechReadableStream(text);
    const resource = createAudioResource(audioStream, {
      inputType: StreamType.OggOpus,
    });

    // キューに追加して順番に再生
    await enqueueAudio(conn, resource);
  } catch (err) {
    console.error("Error in messageCreate event:", err);
  }
});

// --- Audio queue system ---
const audioPlayer = createAudioPlayer();
const audioQueue: ReturnType<typeof createAudioResource>[] = [];
let isPlaying = false;

audioPlayer.on(AudioPlayerStatus.Idle, () => {
  isPlaying = false;
  processQueue();
});

audioPlayer.on("error", (error: Error) => {
  console.error("AudioPlayer error:", error);
  isPlaying = false;
  processQueue();
});

function processQueue(): void {
  if (isPlaying || audioQueue.length === 0) {
    return;
  }
  const resource = audioQueue.shift();
  if (resource) {
    isPlaying = true;
    audioPlayer.play(resource);
  }
}

async function enqueueAudio(
  conn: VoiceConnection,
  resource: ReturnType<typeof createAudioResource>
): Promise<void> {
  conn.subscribe(audioPlayer);
  audioQueue.push(resource);
  processQueue();
}

discordClient.once("clientReady", () => {
  console.log("ready......");
});

discordClient.login(DISCORD_TOKEN);
