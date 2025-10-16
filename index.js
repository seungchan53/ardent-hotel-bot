// ------------------------------------
// Ardent Hotel Discord Bot — Integrated (Rooms auto voice + Communication waiting room)
// ------------------------------------
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

// ---------- Data setup ----------
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

// ---------- 자동 환영 메시지 ----------
client.on("guildMemberAdd", async (member) => {
  const guild = member.guild;
  const welcomeChannel = guild.channels.cache.find(
    (c) => c.name === "💬｜welcome" && c.type === ChannelType.GuildText
  );
  if (welcomeChannel) {
    welcomeChannel.send(
      `🎉 **${guild.name}**에 오신 걸 환영합니다, <@${member.id}>님! 🏨\n` +
      `체크인을 위해 <#📋｜check-in> 채널로 이동해주세요.`
    );
  }
});

// ---------- Reaction Role Setup ----------
const roleMessages = {};

client.on("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (!guild) return console.log("⚠️ Bot is not in any guild.");
  await setupCheckInReactionRoles(guild);
});

async function setupCheckInReactionRoles(guild) {
  const channel = guild.channels.cache.find(ch => ch.name.includes("check-in"));
  if (!channel) return console.log("⚠️ check-in 채널을 찾을 수 없습니다.");

  const messages = await channel.messages.fetch({ limit: 10 });
  const existing = messages.find(m => m.author.id === guild.members.me.id);
  if (existing) {
    roleMessages[guild.id] = existing.id;
    return console.log("✅ 기존 check-in 메시지를 사용합니다.");
  }

  const embed = {
    color: 0xEAB543,
    title: "🏨 Ardent Hotel에 오신 것을 환영합니다!",
    description:
      "체크인하시려면 아래 이모지를 눌러주세요 👇\n\n"
      + "🧍 → **손님 역할 받기**\n\n"
      + "이모지를 누르면 자동으로 손님 역할이 부여됩니다.",
    footer: { text: "감사합니다. 좋은 숙박 되세요!" }
  };

  const msg = await channel.send({ embeds: [embed] });
  await msg.react("🧍");

  roleMessages[guild.id] = msg.id;
  console.log("✅ check-in 반응 역할 메시지 생성 완료");
}

client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;

    // 🔧 Partial 처리
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const guild = reaction.message.guild;
    if (!roleMessages[guild.id] || reaction.message.id !== roleMessages[guild.id]) return;
    if (reaction.emoji.name !== "🧍") return;

    const member = await guild.members.fetch(user.id);
    const guestRole = guild.roles.cache.find(r => r.name === "손님");
    if (!guestRole) return console.log("⚠️ '손님' 역할을 찾을 수 없습니다.");

    if (!member.roles.cache.has(guestRole.id)) {
      await member.roles.add(guestRole);
      console.log(`🎉 ${member.user.tag} → 손님 역할 부여 완료`);
    }

    // 👇 이모지 반응 제거 → 숫자 다시 1로
    await reaction.users.remove(user.id);

  } catch (err) {
    console.error("❌ Reaction Role Error:", err);
  }
});

// ---------- 봇 준비 시 ----------
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (guild) await setupCheckInReactionRoles(guild);
});


client.login(TOKEN);

