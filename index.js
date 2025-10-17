// ------------------------------------
// Ardent Hotel Discord Bot — Stable Full Integration (Fixed)
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
fs.ensureDirSync(DATA_DIR);

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
  { name: "👑 총지배인", color: "#FFD700", perms: [PermissionsBitField.Flags.Administrator] },
  { name: "🧳 지배인", color: "#E74C3C", perms: [PermissionsBitField.Flags.ManageChannels] },
  { name: "🧹 직원", color: "#95A5A6", perms: [] },
  { name: "💼 VIP 손님", color: "#9B59B6", perms: [] },
  { name: "🛎️ 손님", color: "#FFFFFF", perms: [] },
  { name: "🤖 봇", color: "#3498DB", perms: [] },
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

  for (const def of ROLE_DEFS) {
    if (!guild.roles.cache.find(r => r.name === def.name)) {
      await guild.roles.create({ name: def.name, color: def.color, permissions: def.perms });
      console.log(`➕ Created role: ${def.name}`);
    }
  }

  for (const cat of CATEGORY_DEFS) {
    let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === cat.name);
    if (!category) category = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory });

    for (const chName of (CHANNEL_DEFS[cat.name] || [])) {
      if (!guild.channels.cache.find(c => c.name === chName && c.parentId === category.id)) {
        await guild.channels.create({ name: chName, type: ChannelType.GuildText, parent: category });
      }
    }
  }

  // 🛏️ ROOMS 커스터마이징
  const roomsCat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === "🛏️ ROOMS");
  if (roomsCat) {
    const comm = guild.channels.cache.find(
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
  const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
  await logChannel.send({ embeds: [embed] }).catch(() => {});
}

// ---------- Voice Room Logic ----------
client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const roomsCat = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === "🛏️ ROOMS"
    );
    const comm = guild.channels.cache.find(
      c => c.type === ChannelType.GuildVoice && c.parentId === roomsCat?.id && c.name === "Communication"
    );
    if (!roomsCat || !comm) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    // 🔹 중복 이벤트 방지
    if (member._roomCooldown) return;
    member._roomCooldown = true;
    setTimeout(() => (member._roomCooldown = false), 4000);

    // ✅ Communication 입장 → 방 생성
    if (newState.channelId === comm.id && oldState.channelId !== comm.id) {
      const existingRooms = guild.channels.cache.filter(
        c => c.parentId === roomsCat.id && c.type === ChannelType.GuildVoice && /^Room\s\d{3}$/.test(c.name)
      );

      const usedNums = [...existingRooms.values()].map(c => parseInt(c.name.split(" ")[1]));
      let nextNum = 101;
      while (usedNums.includes(nextNum)) nextNum++;

      const guestRole = guild.roles.cache.find(r => r.name === "🛎️ 손님");
      const vipRole = guild.roles.cache.find(r => r.name === "💼 VIP 손님");

      const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      ];

      if (guestRole)
        overwrites.push({
          id: guestRole.id,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect],
        });

      if (vipRole)
        overwrites.push({
          id: vipRole.id,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect],
        });

      const room = await guild.channels.create({
        name: `Room ${nextNum}`,
        type: ChannelType.GuildVoice,
        parent: roomsCat.id,
        permissionOverwrites: overwrites,
      });

      await member.voice.setChannel(room).catch(() => {});
      sendLog(guild, "🛏️ 새로운 통화방 생성", `${member.user.tag}님이 **Room ${nextNum}**에 입장했습니다.`, "#00BFFF");
    }

    // ✅ 나간 채널이 Room일 때만 삭제
    if (oldState.channel && /^Room\s\d{3}$/.test(oldState.channel.name)) {
      const oldRoom = oldState.channel;
      if (newState.channel && newState.channel.parentId === roomsCat.id) return;

      setTimeout(async () => {
        const target = guild.channels.cache.get(oldRoom.id);
        if (target && target.members.size === 0) {
          await target.delete().catch(() => {});
          sendLog(guild, "🧹 통화방 삭제", `**${oldRoom.name}**이 비어 있어 삭제되었습니다.`, "#808080");
        }
      }, 4000);
    }
  } catch (err) {
    console.error("voiceStateUpdate error:", err);
  }
});

// ✅ 중복된 import, client.login("YOUR_TOKEN_HERE") 제거됨

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

// ✅ 손님 역할 부여
client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();

  const CHECKIN_MESSAGE_ID = "1428420681296642241";
  if (reaction.message.id !== CHECKIN_MESSAGE_ID) return;
  if (reaction.emoji.name !== "🧍") return;

  const guild = reaction.message.guild;
  const member = guild.members.cache.get(user.id);
  if (!member) return;

  const guestRole = guild.roles.cache.find(r => r.name === "🛎️ 손님");
  if (!guestRole) return;

  try {
    const vipRole = guild.roles.cache.find(r => r.name === "💼 VIP 손님");
    if (vipRole && member.roles.cache.has(vipRole.id)) await member.roles.remove(vipRole);

    if (!member.roles.cache.has(guestRole.id)) {
      await member.roles.add(guestRole);
      sendLog(guild, "🧍 손님 체크인", `${member.user.tag}님이 체크인하여 **손님 역할**을 부여받았습니다.`, "#FFD700");
    }

    await reaction.users.remove(user.id);
  } catch (err) {
    console.error("❌ 역할 부여 중 오류:", err);
  }
});

// ---------- Welcome ----------
client.on("guildMemberAdd", async (member) => {
  const welcomeChannelId = "1428379298535837889";
  const rulesChannelId = "1428379301442748448";
  const introChannelId = "1428379307335618582";
  const checkInChannelId = "1428379339350872172";

  const channel = member.guild.channels.cache.get(welcomeChannelId);
  if (!channel) return;

  const embed = {
    color: 0xf5c542,
    title: "🎉 Ardent Hotel에 오신 걸 환영합니다! 🏨",
    description: `${member}님, 환영합니다!\n\n🏷️ **서버 규칙**은 <#${rulesChannelId}>에서 확인해주세요.\n🪶 **자기소개**는 <#${introChannelId}>에 작성해주세요.\n📋 **체크인**은 <#${checkInChannelId}>에서 진행해주세요.\n\n즐거운 시간 보내세요! 🌟`,
    thumbnail: { url: "https://cdn-icons-png.flaticon.com/512/235/235861.png" },
    footer: { text: "Ardent Hotel 프론트 데스크" },
  };

  await channel.send({ embeds: [embed] });
});

client.on("guildMemberRemove", async (m) => {
  sendLog(m.guild, "🚪 손님 퇴장", `${m.user.tag}님이 서버를 떠났습니다.`, "#FF6347");
});

// ---------- Express ----------
const app = express();
app.get("/", (req, res) => res.send("Ardent Hotel Bot is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server running on port ${PORT}`));
setInterval(() => console.log("💓 Bot heartbeat"), 1000 * 60 * 5);

client.login(TOKEN);
