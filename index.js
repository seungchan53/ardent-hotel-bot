// ------------------------------------
// Ardent Hotel Discord Bot — Render Compatible Full Integration + Logs System
// ------------------------------------

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder
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

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// ---------- Role + Channel Setup ----------
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
  "☕ GUEST LOUNGE": ["🗨️｜lounge-chat", "🎮｜game-room", "🎨｜fan-art"],
  "🛏️ ROOMS": [],
  "🛠️ FRONT DESK": ["📋｜check-in", "💬｜help-desk", "🔔｜logs"],
  "🎉 EVENT HALL": ["🎊｜event-info", "🏆｜leaderboard"],
};

// ---------- Server structure setup ----------
async function ensureServerStructure(guild) {
  console.log("🏗️ Setting up server structure...");

  // Roles
  for (const def of ROLE_DEFS) {
    let role = guild.roles.cache.find(r => r.name === def.name);
    if (!role) {
      await guild.roles.create({ name: def.name, color: def.color, permissions: def.perms });
      console.log(`➕ Created role: ${def.name}`);
    }
  }

  // Categories & Channels
  for (const cat of CATEGORY_DEFS) {
    let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === cat.name);
    if (!category) {
      category = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory });
      console.log(`📁 Created category: ${cat.name}`);
    }

    const channels = CHANNEL_DEFS[cat.name] || [];
    for (const chName of channels) {
      if (!guild.channels.cache.find(c => c.name === chName && c.parentId === category.id)) {
        await guild.channels.create({ name: chName, type: ChannelType.GuildText, parent: category });
        console.log(`💬 Created channel: ${chName}`);
      }
    }
  }

  // 🛏️ ROOMS 커스터마이징
  const roomsCat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === "🛏️ ROOMS");
  if (roomsCat) {
    const textCh = guild.channels.cache.filter(c => c.parentId === roomsCat.id && c.type === ChannelType.GuildText);
    for (const [, ch] of textCh) await ch.delete().catch(() => {});

    let comm = guild.channels.cache.find(
      c => c.type === ChannelType.GuildVoice && c.parentId === roomsCat.id && c.name === "Communication"
    );
    if (!comm) {
      await guild.channels.create({
        name: "Communication",
        type: ChannelType.GuildVoice,
        parent: roomsCat.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ViewChannel] },
        ],
      });
      console.log("🎤 Created Communication waiting room");
    }
  }

  // ✅ Logs 채널 권한 제한
  const logsChannel = guild.channels.cache.find(c => c.name.includes("logs"));
  if (logsChannel) {
    const gm = guild.roles.cache.find(r => r.name === "👑 총지배인");
    const manager = guild.roles.cache.find(r => r.name === "🧳 지배인");
    if (gm && manager) {
      await logsChannel.permissionOverwrites.set([
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: gm.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        { id: manager.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      ]);
      console.log("🔒 Logs 채널 권한이 총지배인·지배인 전용으로 설정됨");
    }
  }

  console.log("✅ Server structure ready!");
}

// ---------- Logs Helper ----------
async function sendLog(guild, title, description, color = "#6A5ACD") {
  const logChannel = guild.channels.cache.find(c => c.name.includes("logs"));
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();

  await logChannel.send({ embeds: [embed] });
}

// ---------- Auto Voice Room Logic ----------
const AUTO_FLOORS = 5;
const ROOMS_PER_FLOOR = 3;
const AUTO_DELETE_DELAY = 5000;
let timers = new Map();

function allowedRooms() {
  const nums = [];
  for (let f = 1; f <= AUTO_FLOORS; f++) for (let r = 1; r <= ROOMS_PER_FLOOR; r++) nums.push(f * 100 + r);
  return nums;
}
function pickRoom(existing) {
  for (const n of allowedRooms()) if (!existing.includes(n)) return n;
  return null;
}

const { ChannelType, PermissionsBitField, EmbedBuilder } = require("discord.js");

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const roomsCat = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === "🛏️ ROOMS"
    );
    if (!roomsCat) return;

    const comm = guild.channels.cache.find(
      c => c.type === ChannelType.GuildVoice &&
           c.parentId === roomsCat.id &&
           c.name === "Communication"
    );
    if (!comm) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    // ✅ 중복 이벤트 방지 (2초 쿨타임)
    if (member._voiceLock) return;
    member._voiceLock = true;
    setTimeout(() => (member._voiceLock = false), 2000);

    // ✅ Communication 입장 시 새 방 생성
    if (newState.channelId === comm.id && oldState.channelId !== comm.id) {
      const exist = guild.channels.cache
        .filter(c => c.parentId === roomsCat.id && c.type === ChannelType.GuildVoice && /^Room\s\d{3}$/.test(c.name))
        .map(c => parseInt(c.name.split(" ")[1]));
      
      const nextNum = (() => {
        for (let i = 101; i <= 999; i++) if (!exist.includes(i)) return i;
        return null;
      })();

      if (!nextNum) return;

      // 🔒 생성 중 중복 방지
      if (guild._creatingRoom) return;
      guild._creatingRoom = true;

      const room = await guild.channels.create({
        name: `Room ${nextNum}`,
        type: ChannelType.GuildVoice,
        parent: roomsCat.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ViewChannel] },
        ],
      });

      await member.voice.setChannel(room).catch(() => {});
      guild._creatingRoom = false;

      sendLog(
        guild,
        "🛏️ 새로운 통화방 생성",
        `${member.user.tag}님이 **Room ${nextNum}**에 입장했습니다.`,
        "#00BFFF"
      );
    }

    // ✅ 나간 채널이 Room이면 삭제 예약
    if (oldState.channel && /^Room\s\d{3}$/.test(oldState.channel.name)) {
      const ch = oldState.channel;

      // 이동 중이면 삭제하지 않음
      if (newState.channel && newState.channel.parentId === roomsCat.id) return;

      // 중복 삭제 방지
      if (ch._deleting) return;
      ch._deleting = true;

      setTimeout(async () => {
        const updated = guild.channels.cache.get(ch.id);
        if (updated && updated.members.size === 0) {
          await updated.delete().catch(() => {});
          sendLog(
            guild,
            "🧹 통화방 삭제",
            `**${ch.name}**이 비어 있어 삭제되었습니다.`,
            "#808080"
          );
        }
        ch._deleting = false;
      }, 3000);
    }
  } catch (err) {
    console.error("voiceStateUpdate error:", err);
  }
});




// ---------- Reaction Role ----------
const roleMessages = {};

client.on("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (guild) {
    await ensureServerStructure(guild);
    await setupCheckIn(guild);
  }
});

async function setupCheckIn(guild) {
  const ch = guild.channels.cache.find(c => c.name.includes("check-in"));
  if (!ch) return console.log("⚠️ check-in 채널 없음");

  const msgs = await ch.messages.fetch({ limit: 10 });
  const exist = msgs.find(m => m.author.id === guild.members.me.id);
  if (exist) {
    roleMessages[guild.id] = exist.id;
    console.log("♻️ 기존 check-in 메시지 사용");
    return;
  }

  const embed = {
    color: 0xEAB543,
    title: "🏨 Ardent Hotel에 오신 것을 환영합니다!",
    description: "체크인하시려면 아래 이모지를 눌러주세요 👇\n\n🧍 → **손님 역할 받기**\n\n감사합니다. 좋은 숙박 되세요!",
  };

  const msg = await ch.send({ embeds: [embed] });
  await msg.react("🧍");
  roleMessages[guild.id] = msg.id;
  console.log("✅ check-in 메시지 생성 완료");
}

// ✅ 손님 역할만 이모지로 부여
client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();

  const CHECKIN_MESSAGE_ID = "1428420681296642241"; // 실제 메시지 ID 유지
  if (reaction.message.id !== CHECKIN_MESSAGE_ID) return;
  if (reaction.emoji.name !== "🧍") return;

  const guild = reaction.message.guild;
  const member = guild.members.cache.get(user.id);
  if (!member) return;

  const guestRole = guild.roles.cache.find(r => r.name === "🛎️ 손님");
  if (!guestRole) return console.log("❌ 손님 역할을 찾을 수 없습니다.");

  try {
    const vipRole = guild.roles.cache.find(r => r.name === "💼 VIP 손님");
    if (vipRole && member.roles.cache.has(vipRole.id)) {
      await member.roles.remove(vipRole);
      console.log(`❎ ${member.user.tag}의 VIP 손님 역할 제거`);
    }

    if (!member.roles.cache.has(guestRole.id)) {
      await member.roles.add(guestRole);
      console.log(`✅ ${member.user.tag}에게 손님 역할 부여`);
      sendLog(guild, "🧍 손님 체크인", `${member.user.tag}님이 체크인하여 **손님 역할**을 부여받았습니다.`, "#FFD700");
    }

    await reaction.users.remove(user.id);
  } catch (err) {
    console.error("❌ 역할 부여 중 오류:", err);
  }
});

// ---------- Welcome ----------
client.on("guildMemberAdd", async (m) => {
  const ch = m.guild.channels.cache.find(c => c.name === "💬｜welcome");
  if (ch) ch.send(`🎉 ${m}님, **${m.guild.name}**에 오신 걸 환영합니다! 🏨\n체크인은 <#📋｜check-in>에서 진행해주세요.`);
  sendLog(m.guild, "👋 새 손님 입장", `${m.user.tag}님이 서버에 입장했습니다.`, "#00FA9A");
});

client.on("guildMemberRemove", async (m) => {
  sendLog(m.guild, "🚪 손님 퇴장", `${m.user.tag}님이 서버를 떠났습니다.`, "#FF6347");
});

// ---------- Express (Render port binding fix) ----------
const app = express();
app.get("/", (req, res) => res.send("Ardent Hotel Bot is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server running on port ${PORT}`));
setInterval(() => console.log("💓 Bot heartbeat"), 1000 * 60 * 5);

// ---------- Start ----------
client.login(TOKEN);
