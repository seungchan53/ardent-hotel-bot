// ------------------------------------
// Ardent Hotel Discord Bot (Full + Voice Rooms "Room 101" 형식)
// ------------------------------------

const { 
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionsBitField, ChannelType
} = require("discord.js");
const fs = require("fs-extra");
const path = require("path");

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TOKEN environment variable. Set TOKEN in Render environment variables.");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "data");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const CHECKINS_FILE = path.join(DATA_DIR, "checkins.json");

fs.ensureDirSync(DATA_DIR);
if (!fs.existsSync(ROOMS_FILE)) fs.writeJsonSync(ROOMS_FILE, {});
if (!fs.existsSync(CHECKINS_FILE)) fs.writeJsonSync(CHECKINS_FILE, {});

const readRooms = () => fs.readJsonSync(ROOMS_FILE);
const writeRooms = (obj) => fs.writeJsonSync(ROOMS_FILE, obj, { spaces: 2 });
const readCheckins = () => fs.readJsonSync(CHECKINS_FILE);
const writeCheckins = (obj) => fs.writeJsonSync(CHECKINS_FILE, obj, { spaces: 2 });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates // 음성 상태 감지
  ],
  partials: [Partials.Channel],
});

// ──────────────────────────────
// Slash commands 등록 (기존 내용 유지)
// ──────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("checkin")
    .setDescription("체크인하고 손님 역할을 받습니다.")
    .addStringOption(opt =>
      opt.setName("notes").setDescription("체크인 메모 (선택)").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("room")
    .setDescription("개인 객실을 생성하거나 삭제합니다.")
    .addStringOption(opt =>
      opt.setName("action").setDescription("create 또는 close").setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("name").setDescription("객실 이름 (선택)").setRequired(false)
    ),
].map(c => c.toJSON());

const ROLE_DEFS = [
  { key: "GM", name: "👑 총지배인", color: "#FFD700", perms: [PermissionsBitField.Flags.Administrator] },
  { key: "MANAGER", name: "🧳 지배인", color: "#E74C3C", perms: [PermissionsBitField.Flags.ManageChannels] },
  { key: "STAFF", name: "🧹 직원", color: "#95A5A6", perms: [] },
  { key: "VIP", name: "💼 VIP 손님", color: "#9B59B6", perms: [] },
  { key: "GUEST", name: "🛎️ 손님", color: "#FFFFFF", perms: [] },
  { key: "BOT", name: "🤖 봇", color: "#3498DB", perms: [] },
];

const CATEGORY_DEFS = [
  { name: "🏛️ LOBBY" },
  { name: "☕ GUEST LOUNGE" },
  { name: "🛏️ ROOMS" },
  { name: "🛠️ FRONT DESK" },
  { name: "🎉 EVENT HALL" },
];

const CHANNEL_DEFS = {
  "🏛️ LOBBY": ["💬｜welcome", "🏷️｜rules", "📰｜announcements", "🪶｜introductions"],
  "☕ GUEST LOUNGE": ["🗨️｜lounge-chat", "🎮｜game-room", "🎨｜fan-art", "💡｜suggestions"],
  "🛏️ ROOMS": ["🛏️｜vip-room", "🧑‍💼｜staff-room", "🗝️｜private-room"],
  "🛠️ FRONT DESK": ["📋｜check-in", "💬｜help-desk", "🔔｜logs"],
  "🎉 EVENT HALL": ["🎊｜event-info", "🏆｜leaderboard", "🎁｜rewards"],
};

const wait = (ms) => new Promise(res => setTimeout(res, ms));

async function registerGuildCommands(guildId) {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
    console.log(`✅ 슬래시 명령어 등록 완료 (${guildId})`);
  } catch (err) {
    console.error("❌ 슬래시 명령어 등록 실패:", err);
  }
}

async function ensureServerStructure(guild) {
  console.log("🏗️ 서버 구조 검사 및 생성 시작...");

  const rolesMap = {};
  for (const def of ROLE_DEFS) {
    let role = guild.roles.cache.find(r => r.name === def.name);
    if (!role) {
      console.log(`➕ 역할 생성: ${def.name}`);
      role = await guild.roles.create({ name: def.name, color: def.color, permissions: def.perms });
      await wait(500);
    } else console.log(`✔ 역할 존재: ${def.name}`);
    rolesMap[def.key] = role;
  }

  for (const catDef of CATEGORY_DEFS) {
    let category = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === catDef.name);
    if (!category) {
      console.log(`➕ 카테고리 생성: ${catDef.name}`);
      category = await guild.channels.create({ name: catDef.name, type: ChannelType.GuildCategory });
      await wait(500);
    }
    const channels = CHANNEL_DEFS[catDef.name] || [];
    for (const chName of channels) {
      let ch = guild.channels.cache.find(c => c.name === chName && c.parentId === category.id);
      if (!ch) {
        console.log(`➕ 채널 생성: ${chName}`);
        await guild.channels.create({ name: chName, type: ChannelType.GuildText, parent: category });
        await wait(400);
      }
    }
  }

  console.log("🏨 서버 구조 확인 완료!");
  return rolesMap;
}

async function logAction(guild, message) {
  const logChannel = guild.channels.cache.find(ch => ch.name === "🔔｜logs" && ch.type === ChannelType.GuildText);
  if (logChannel) await logChannel.send({ content: message });
  else console.log("[LOG]", message);
}

// ──────────────────────────────
// 명령어 처리 (기존)
// ──────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, user } = interaction;

  try {
    if (commandName === "checkin") {
      const notes = interaction.options.getString("notes") || "없음";
      const guestRole = guild.roles.cache.find(r => r.name === "🛎️ 손님");
      if (!guestRole) return interaction.reply({ content: "❌ 손님 역할을 찾을 수 없습니다.", ephemeral: true });

      await interaction.member.roles.add(guestRole);
      const checkins = readCheckins();
      checkins[user.id] = { userTag: user.tag, at: new Date().toISOString(), notes };
      writeCheckins(checkins);

      await interaction.reply({ content: `✅ 체크인 완료 — ${user.tag}님, 환영합니다!`, ephemeral: false });
      await logAction(guild, `🛎️ ${user.tag} 체크인 — 메모: ${notes}`);
    }

    if (commandName === "room") {
      const action = interaction.options.getString("action").toLowerCase();
      const nameOption = interaction.options.getString("name");
      const rooms = readRooms();

      const roomsCategory = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === "🛏️ ROOMS");
      if (!roomsCategory) return interaction.reply({ content: "❌ ROOMS 카테고리를 찾을 수 없습니다.", ephemeral: true });

      if (action === "create") {
        if (rooms[user.id]) {
          return interaction.reply({ content: `❗ 이미 개인 객실이 있습니다: <#${rooms[user.id].channelId}>`, ephemeral: true });
        }

        const safeName = nameOption ? nameOption.replace(/[^a-zA-Z0-9-_가-힣]/g, "").slice(0, 20) : `room-${user.username}`.toLowerCase();
        let channelName = `🔒-${safeName}`;
        let counter = 1;
        while (guild.channels.cache.some(c => c.name === channelName)) {
          channelName = `🔒-${safeName}-${counter++}`;
        }

        const staffRole = guild.roles.cache.find(r => r.name === "🧹 직원");
        const everyone = guild.roles.everyone;

        const overwrites = [
          { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        ];
        if (staffRole) overwrites.push({ id: staffRole.id, allow: [PermissionsBitField.Flags.ViewChannel] });

        const newRoom = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: roomsCategory,
          permissionOverwrites: overwrites,
        });

        rooms[user.id] = { channelId: newRoom.id, name: channelName };
        writeRooms(rooms);

        await interaction.reply({ content: `🏠 객실 생성 완료: ${newRoom}`, ephemeral: true });
        await logAction(guild, `🏠 ${user.tag} 개인 객실 생성됨 → ${newRoom}`);
      }

      if (action === "close") {
        if (!rooms[user.id]) {
          return interaction.reply({ content: "❌ 당신의 객실이 없습니다.", ephemeral: true });
        }

        const roomInfo = rooms[user.id];
        const ch = guild.channels.cache.get(roomInfo.channelId);
        if (ch) await ch.delete("사용자 요청으로 객실 닫기");
        delete rooms[user.id];
        writeRooms(rooms);

        await interaction.reply({ content: `🚪 객실이 닫혔습니다. 감사합니다!`, ephemeral: true });
        await logAction(guild, `🚪 ${user.tag} 개인 객실 삭제`);
      }
    }
  } catch (err) {
    console.error(err);
    try { await interaction.reply({ content: "⚠️ 명령 실행 중 오류가 발생했습니다.", ephemeral: true }); } catch(e) {}
  }
});

// ──────────────────────────────
// 🎧 자동 음성방 시스템 ("Room 101" 스타일)
// ──────────────────────────────
const LOBBY_VOICE_NAME = "🎤｜Lobby"; // 대기실 채널 이름
const CATEGORY_VOICE_NAME = "🎧 Voice Rooms"; // 자동 생성 방을 넣을 카테고리
const AUTO_DELETE_DELAY = 5000; // 5초 (밀리초)

const autoDeleteTimers = new Map(); // 채널ID -> timeoutID

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = (newState?.guild || oldState?.guild);
    if (!guild) return;

    // 카테고리 확인/생성
    let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === CATEGORY_VOICE_NAME);
    if (!category) {
      category = await guild.channels.create({ name: CATEGORY_VOICE_NAME, type: ChannelType.GuildCategory });
    }

    // Lobby 채널 확인/생성 (카테고리 안에 넣음)
    let lobby = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.name === LOBBY_VOICE_NAME);
    if (!lobby) {
      lobby = await guild.channels.create({ name: LOBBY_VOICE_NAME, type: ChannelType.GuildVoice, parent: category.id });
    }

    // --- 1) 누군가 어떤 채널에 들어왔을 때(newState.channel) --- 
    if (newState && newState.channel) {
      // 만약 누군가 auto채널에 들어온다면 삭제 타이머 취소
      if (autoDeleteTimers.has(newState.channel.id)) {
        clearTimeout(autoDeleteTimers.get(newState.channel.id));
        autoDeleteTimers.delete(newState.channel.id);
      }
    }

    // --- 2) Lobby에 들어온 경우에만 작동 (새 방 생성) ---
    if (newState && newState.channel && newState.channel.id === lobby.id) {
      const member = newState.member;

      // 기존 자동 채널들 중 숫자 추출: "Room 101" 패턴에서 숫자만
      const existingNumbers = guild.channels.cache
        .filter(ch => ch.parentId === category.id && ch.type === ChannelType.GuildVoice)
        .map(ch => {
          const m = ch.name.match(/^Room\s+(\d{3})$/);
          return m ? parseInt(m[1], 10) : null;
        })
        .filter(n => Number.isInteger(n));

      const nextNumber = existingNumbers.length ? Math.max(...existingNumbers) + 1 : 101;
      const nameNumber = String(nextNumber).padStart(3, '0'); // 101 -> "101"
      const newChannelName = `Room ${nameNumber}`;

      // 새 음성채널 생성
      const newVoice = await guild.channels.create({
        name: newChannelName,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.roles.everyone, allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ViewChannel] },
        ],
      });

      // 유저 이동
      try {
        await member.voice.setChannel(newVoice);
      } catch (e) {
        console.error("유저 이동 실패:", e);
      }

      // 자동 삭제: 방이 비면 5초 후 삭제 (다시 사람이 들어오면 취소)
      const scheduleDelete = () => {
        if (autoDeleteTimers.has(newVoice.id)) clearTimeout(autoDeleteTimers.get(newVoice.id));
        const t = setTimeout(async () => {
          const refreshed = guild.channels.cache.get(newVoice.id);
          if (refreshed && refreshed.members.size === 0) {
            try {
              await refreshed.delete("자동 음성 채널 정리");
            } catch (e) {
              console.error("자동 삭제 실패:", e);
            }
          }
          autoDeleteTimers.delete(newVoice.id);
        }, AUTO_DELETE_DELAY);
        autoDeleteTimers.set(newVoice.id, t);
      };

      // 처음 생성 직후에도 비어있다면 스케줄링 (긴급 경우)
      if (newVoice.members.size === 0) scheduleDelete();
    }

    // --- 3) 누군가 떠났을 때(oldState.channel) --- 
    if (oldState && oldState.channel) {
      const leftChannel = guild.channels.cache.get(oldState.channel.id);
      if (leftChannel && leftChannel.parentId === (category?.id) && leftChannel.type === ChannelType.GuildVoice) {
        // 자동 채널이고 현재 인원이 0이라면 삭제 예약
        if (leftChannel.members.size === 0) {
          if (autoDeleteTimers.has(leftChannel.id)) clearTimeout(autoDeleteTimers.get(leftChannel.id));
          const t = setTimeout(async () => {
            const refreshed = guild.channels.cache.get(leftChannel.id);
            if (refreshed && refreshed.members.size === 0) {
              try {
                await refreshed.delete("자동 음성 채널 정리");
              } catch (e) {
                console.error("자동 삭제 실패:", e);
              }
            }
            autoDeleteTimers.delete(leftChannel.id);
          }, AUTO_DELETE_DELAY);
          autoDeleteTimers.set(leftChannel.id, t);
        }
      }
    }
  } catch (err) {
    console.error("voiceStateUpdate 처리 중 오류:", err);
  }
});

// ──────────────────────────────
// Render용 웹서버 + heartbeat (종료 방지)
// ──────────────────────────────
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Ardent Hotel Bot is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server started on port ${PORT}`));
setInterval(() => console.log("💓 Bot is active - heartbeat"), 1000 * 60 * 5);

// ──────────────────────────────
// 봇 실행
// ──────────────────────────────
client.once("ready", async () => {
  console.log(`✅ 로그인 완료: ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (!guild) return console.log("⚠️ 봇이 서버에 초대되어 있어야 합니다!");

  await ensureServerStructure(guild);
  await registerGuildCommands(guild.id);
  console.log("🏨 Ardent Hotel 봇 준비 완료!");
});

client.login(TOKEN);
