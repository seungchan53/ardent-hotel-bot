// ------------------------------------
// Ardent Hotel Discord Bot — Integrated (Rooms auto voice + Communication waiting room)
// ------------------------------------

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType
} = require("discord.js");
const fs = require("fs-extra");
const path = require("path");
const express = require("express");

// ---------- Config ----------
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TOKEN environment variable.");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "data");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const CHECKINS_FILE = path.join(DATA_DIR, "checkins.json");
fs.ensureDirSync(DATA_DIR);
if (!fs.existsSync(ROOMS_FILE)) fs.writeJsonSync(ROOMS_FILE, {});
if (!fs.existsSync(CHECKINS_FILE)) fs.writeJsonSync(CHECKINS_FILE, {});

// ---------- FS helpers ----------
const readRooms = () => fs.readJsonSync(ROOMS_FILE);
const writeRooms = (obj) => fs.writeJsonSync(ROOMS_FILE, obj, { spaces: 2 });
const readCheckins = () => fs.readJsonSync(CHECKINS_FILE);
const writeCheckins = (obj) => fs.writeJsonSync(CHECKINS_FILE, obj, { spaces: 2 });

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ---------- Slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName("checkin")
    .setDescription("체크인하고 손님 역할을 받습니다.")
    .addStringOption(opt => opt.setName("notes").setDescription("체크인 메모 (선택)").setRequired(false)),
  new SlashCommandBuilder()
    .setName("room")
    .setDescription("개인 객실을 생성하거나 삭제합니다.")
    .addStringOption(opt => opt.setName("action").setDescription("create 또는 close").setRequired(true))
    .addStringOption(opt => opt.setName("name").setDescription("객실 이름 (선택)").setRequired(false)),
].map(c => c.toJSON());

// ---------- Defaults ----------
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
  { name: "🛏️ ROOMS" }, // 🛏️ Rooms 카테고리 이름 수정
  { name: "🛠️ FRONT DESK" },
  { name: "🎉 EVENT HALL" },
];

const CHANNEL_DEFS = {
  "🏛️ LOBBY": ["💬｜welcome", "🏷️｜rules", "📰｜announcements", "🪶｜introductions"],
  "☕ GUEST LOUNGE": ["🗨️｜lounge-chat", "🎮｜game-room", "🎨｜fan-art"],
  "🛏️ ROOMS": [], // 🛏️ ROOMS 안에는 텍스트 채널 없음
  "🛠️ FRONT DESK": ["📋｜check-in", "💬｜help-desk", "🔔｜logs"],
  "🎉 EVENT HALL": ["🎊｜event-info", "🏆｜leaderboard"],
};

// ---------- Utilities ----------
const wait = ms => new Promise(res => setTimeout(res, ms));

// ---------- Guild Structure ----------
async function ensureServerStructure(guild) {
  console.log("🏗️ Setting up server structure...");

  // Roles
  for (const def of ROLE_DEFS) {
    let role = guild.roles.cache.find(r => r.name === def.name);
    if (!role) {
      role = await guild.roles.create({ name: def.name, color: def.color, permissions: def.perms });
      console.log(`➕ Created role: ${def.name}`);
      await wait(300);
    }
  }

  // Categories + Text Channels
  for (const catDef of CATEGORY_DEFS) {
    let category = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === catDef.name);
    if (!category) {
      category = await guild.channels.create({ name: catDef.name, type: ChannelType.GuildCategory });
      console.log(`📁 Created category: ${catDef.name}`);
      await wait(300);
    }

    const channels = CHANNEL_DEFS[catDef.name] || [];
    for (const chName of channels) {
      let ch = guild.channels.cache.find(c => c.name === chName && c.parentId === category.id);
      if (!ch) {
        await guild.channels.create({ name: chName, type: ChannelType.GuildText, parent: category });
        console.log(`💬 Created: ${chName} in ${catDef.name}`);
        await wait(200);
      }
    }
  }

  // 🛏️ ROOMS 구조만 커스터마이징
  const roomsCategory = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === "🛏️ ROOMS");
  if (roomsCategory) {
    // 1️⃣ 기존 텍스트 채널 제거
    const textChannels = guild.channels.cache.filter(c => c.parentId === roomsCategory.id && c.type === ChannelType.GuildText);
    for (const [, ch] of textChannels) await ch.delete().catch(() => {});

    // 2️⃣ Communication 대기방 생성
    let comm = guild.channels.cache.find(
      c => c.type === ChannelType.GuildVoice && c.parentId === roomsCategory.id && c.name === "Communication"
    );
    if (!comm) {
      await guild.channels.create({
        name: "Communication",
        type: ChannelType.GuildVoice,
        parent: roomsCategory.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ViewChannel] },
        ],
      });
      console.log("🎤 Created Communication waiting room");
    }
  }

  console.log("🏨 Server structure ready");
}

// ---------- Auto Voice Room Logic ----------
const AUTO_DELETE_DELAY = 5000;
const AUTO_FLOORS = 5;
const ROOMS_PER_FLOOR = 3;
let autoTimers = new Map();

function getAllAllowedRoomNumbers() {
  const nums = [];
  for (let floor = 1; floor <= AUTO_FLOORS; floor++) {
    for (let r = 1; r <= ROOMS_PER_FLOOR; r++) nums.push(floor * 100 + r);
  }
  return nums; // [101,102,103,...503]
}

function pickNextRoomNumber(existingNumbers) {
  for (const n of getAllAllowedRoomNumbers()) if (!existingNumbers.includes(n)) return n;
  return null;
}

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;
    const roomsCategory = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === "🛏️ ROOMS");
    if (!roomsCategory) return;
    const waiting = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.parentId === roomsCategory.id && c.name === "Communication");
    if (!waiting) return;

    // 유저가 Communication에 들어오면 새 Room 생성
    if (newState.channelId === waiting.id) {
      const member = newState.member;
      const existingRooms = guild.channels.cache
        .filter(ch => ch.parentId === roomsCategory.id && ch.type === ChannelType.GuildVoice && /^Room\s\d{3}$/.test(ch.name))
        .map(ch => parseInt(ch.name.split(" ")[1]));

      const next = pickNextRoomNumber(existingRooms);
      if (!next) return;

      const newRoom = await guild.channels.create({
        name: `Room ${next}`,
        type: ChannelType.GuildVoice,
        parent: roomsCategory.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ViewChannel] },
        ],
      });

      await member.voice.setChannel(newRoom);
      console.log(`🏠 Created Room ${next} for ${member.user.tag}`);

      // 자동 삭제 예약
      const scheduleDelete = (chId) => {
        if (autoTimers.has(chId)) clearTimeout(autoTimers.get(chId));
        const t = setTimeout(async () => {
          const ch = guild.channels.cache.get(chId);
          if (ch && ch.members.size === 0) {
            await ch.delete().catch(() => {});
            console.log(`🗑️ Deleted ${ch.name}`);
          }
          autoTimers.delete(chId);
        }, AUTO_DELETE_DELAY);
        autoTimers.set(chId, t);
      };
      scheduleDelete(newRoom.id);
    }

    // 유저가 방을 떠났을 때 비어 있으면 삭제 예약
    if (oldState.channel && /^Room\s\d{3}$/.test(oldState.channel.name) && oldState.channel.parentId === roomsCategory.id) {
      const ch = oldState.channel;
      if (ch.members.size === 0) {
        if (autoTimers.has(ch.id)) clearTimeout(autoTimers.get(ch.id));
        const t = setTimeout(async () => {
          const refreshed = guild.channels.cache.get(ch.id);
          if (refreshed && refreshed.members.size === 0) {
            await refreshed.delete().catch(() => {});
            console.log(`🗑️ Deleted ${refreshed.name}`);
          }
          autoTimers.delete(ch.id);
        }, AUTO_DELETE_DELAY);
        autoTimers.set(ch.id, t);
      }
    }
  } catch (err) {
    console.error("voiceStateUpdate error:", err);
  }
});

// ---------- Express server ----------
const app = express();
app.get("/", (req, res) => res.send("Ardent Hotel Bot is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));
setInterval(() => console.log("💓 Bot heartbeat"), 1000 * 60 * 5);

// ---------- Ready ----------
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (!guild) return console.log("⚠️ Bot is not in any guild (invite it first).");
  await ensureServerStructure(guild);
  console.log("🏨 Ardent Hotel Bot Ready!");
});

client.login(TOKEN);
