// ------------------------------------
// Ardent Hotel Discord Bot (Full Version)
// ------------------------------------
// 기능:
// ✅ Render에서 24시간 작동 (자동 종료 방지 heartbeat)
// ✅ 서버 재시작 시 중복 생성 방지
// ✅ 슬래시 명령어: /checkin, /room (create/close)
// ✅ 개인 객실 생성 + 삭제 + 권한 설정
// ✅ 로그 채널(🔔｜logs)에 기록 남김
// ✅ 단일 서버 자동 초기화 (역할/카테고리/채널 구조 자동 생성)
// ------------------------------------

// require('dotenv').config(); // 로컬 테스트 시 주석 해제
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
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

// ──────────────────────────────
// Slash commands 등록
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

// ──────────────────────────────
// 서버 구조 정의
// ──────────────────────────────
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

// ──────────────────────────────
// 유틸 함수
// ──────────────────────────────
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
// 명령어 처리
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
    interaction.reply({ content: "⚠️ 명령 실행 중 오류가 발생했습니다.", ephemeral: true });
  }
});

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

  // Render 자동 종료 방지 (heartbeat)
  setInterval(() => console.log("💓 Bot is active - heartbeat"), 1000 * 60 * 5);
});

client.login(TOKEN);
