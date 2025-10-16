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

// ---------- Defaults (roles / categories) ----------
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
  { name: "Rooms" }, // <-- 정확히 'Rooms' (대소문자 구별)
  { name: "🛠️ FRONT DESK" },
  { name: "🎉 EVENT HALL" },
];

const CHANNEL_DEFS = {
  "🏛️ LOBBY": ["💬｜welcome", "🏷️｜rules", "📰｜announcements", "🪶｜introductions"],
  "☕ GUEST LOUNGE": ["🗨️｜lounge-chat", "🎮｜game-room", "🎨｜fan-art"],
  "Rooms": [], // Rooms 카테고리에는 텍스트 채널 없이 음성방만 둠
  "🛠️ FRONT DESK": ["📋｜check-in", "💬｜help-desk", "🔔｜logs"],
  "🎉 EVENT HALL": ["🎊｜event-info", "🏆｜leaderboard"],
};

// ---------- Utilities ----------
const wait = ms => new Promise(res => setTimeout(res, ms));

async function registerGuildCommands(guildId) {
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
    console.log(`✅ Registered slash commands for guild ${guildId}`);
  } catch (err) {
    console.error("❌ Register commands failed:", err);
  }
}

// ---------- Ensure server structure (roles, categories, channels) ----------
async function ensureServerStructure(guild) {
  console.log("🏗️ ensureServerStructure start...");

  const rolesMap = {};
  for (const def of ROLE_DEFS) {
    let role = guild.roles.cache.find(r => r.name === def.name);
    if (!role) {
      role = await guild.roles.create({ name: def.name, color: def.color, permissions: def.perms });
      console.log(`➕ Created role: ${def.name}`);
      await wait(300);
    } else {
      console.log(`✔ Role exists: ${def.name}`);
    }
    rolesMap[def.key] = role;
  }

  // categories & channels
  for (const catDef of CATEGORY_DEFS) {
    let category = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === catDef.name);
    if (!category) {
      category = await guild.channels.create({ name: catDef.name, type: ChannelType.GuildCategory });
      console.log(`➕ Created category: ${catDef.name}`);
      await wait(300);
    }

    const channels = CHANNEL_DEFS[catDef.name] || [];
    for (const chName of channels) {
      let ch = guild.channels.cache.find(c => c.name === chName && c.parentId === category.id);
      if (!ch) {
        await guild.channels.create({ name: chName, type: ChannelType.GuildText, parent: category });
        console.log(`➕ Created text channel: ${chName} in ${catDef.name}`);
        await wait(200);
      }
    }
  }

  // Rooms category: ensure 'Communication' waiting voice channel exists; remove any text channels inside Rooms
  const roomsCategory = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === "Rooms");
  if (roomsCategory) {
    // remove text channels under Rooms (only if they match CHANNEL_DEFS earlier we decided none). We won't forcibly delete arbitrary channels,
    // but if any text channels exist with name in CHANNEL_DEFS[Rooms] we'd skip; here CHANNEL_DEFS["Rooms"] is empty so we just ensure no text channels are created by us.
    let waiting = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.parentId === roomsCategory.id && c.name === "Communication");
    if (!waiting) {
      await guild.channels.create({
        name: "Communication",
        type: ChannelType.GuildVoice,
        parent: roomsCategory.id,
      });
      console.log("🎧 Created waiting voice channel: Communication (under Rooms)");
    } else {
      console.log("✔ Waiting voice channel already exists: Communication");
    }
  } else {
    console.log("⚠️ Rooms category not found (shouldn't happen)");
  }

  // Create admin-only channels inside FRONT DESK (admin-chat, admin-meeting) — English version
  const frontDesk = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === "🛠️ FRONT DESK");
  if (frontDesk) {
    const roles = {
      everyone: guild.roles.everyone,
      generalManager: guild.roles.cache.find(r => r.name === "👑 총지배인"),
      manager: guild.roles.cache.find(r => r.name === "🧳 지배인"),
    };

    const adminPermissions = [
      { id: roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      ...(roles.generalManager ? [{ id: roles.generalManager.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] }] : []),
      ...(roles.manager ? [{ id: roles.manager.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] }] : []),
    ];

    // admin-chat
    let adminText = guild.channels.cache.find(c => c.name === "admin-chat" && c.parentId === frontDesk.id && c.type === ChannelType.GuildText);
    if (!adminText) {
      await guild.channels.create({
        name: "admin-chat",
        type: ChannelType.GuildText,
        parent: frontDesk.id,
        permissionOverwrites: adminPermissions,
      });
      console.log("➕ Created admin-chat (private)");
    } else console.log("✔ admin-chat exists");

    // admin-meeting (voice)
    let adminVoice = guild.channels.cache.find(c => c.name === "admin-meeting" && c.parentId === frontDesk.id && c.type === ChannelType.GuildVoice);
    if (!adminVoice) {
      await guild.channels.create({
        name: "admin-meeting",
        type: ChannelType.GuildVoice,
        parent: frontDesk.id,
        permissionOverwrites: adminPermissions,
      });
      console.log("➕ Created admin-meeting (private)");
    } else console.log("✔ admin-meeting exists");
  } else {
    console.log("⚠️ FRONT DESK category not found — skipping admin-only channels");
  }

  console.log("🏨 ensureServerStructure complete");
  return rolesMap;
}

// ---------- Logging helper ----------
async function logAction(guild, message) {
  const logChannel = guild.channels.cache.find(ch => ch.name === "🔔｜logs" && ch.type === ChannelType.GuildText);
  if (logChannel) await logChannel.send({ content: message }).catch(() => console.log("[LOG SEND FAIL]", message));
  else console.log("[LOG]", message);
}

// ---------- Command handling (checkin & room commands) ----------
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

      const roomsCategory = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === "Rooms");
      if (!roomsCategory) return interaction.reply({ content: "❌ Rooms 카테고리를 찾을 수 없습니다.", ephemeral: true });

      if (action === "create") {
        if (rooms[user.id]) {
          return interaction.reply({ content: `❗ 이미 개인 객실이 있습니다: <#${rooms[user.id].channelId}>`, ephemeral: true });
        }

        const safeName = nameOption ? nameOption.replace(/[^a-zA-Z0-9-_가-힣]/g, "").slice(0, 20) : `room-${interaction.user.username}`.toLowerCase();
        let channelName = `🔒-${safeName}`;
        let counter = 1;
        while (guild.channels.cache.some(c => c.name === channelName)) {
          channelName = `🔒-${safeName}-${counter++}`;
        }

        const staffRole = guild.roles.cache.find(r => r.name === "🧹 직원");
        const everyone = guild.roles.everyone;

        const overwrites = [
          { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        ];
        if (staffRole) overwrites.push({ id: staffRole.id, allow: [PermissionsBitField.Flags.ViewChannel] });

        const newRoom = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: roomsCategory.id,
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
    console.error("interaction error:", err);
    try { await interaction.reply({ content: "⚠️ 명령 실행 중 오류가 발생했습니다.", ephemeral: true }); } catch(e) {}
  }
});

// ---------- Automatic voice rooms (Communication waiting room -> Room XXX) ----------
const AUTO_DELETE_DELAY = 5000; // 5 seconds
const AUTO_FLOORS = 5;
const ROOMS_PER_FLOOR = 10; // Room 101~110 etc
let autoTimers = new Map();

function getAllAllowedRoomNumbers() {
  const nums = [];
  for (let floor = 1; floor <= AUTO_FLOORS; floor++) {
    for (let r = 1; r <= ROOMS_PER_FLOOR; r++) {
      const num = floor * 100 + r; // floor 1, r1 => 101
      nums.push(num);
    }
  }
  return nums; // [101,102,...,110,201,...,510]
}

function pickNextRoomNumber(existingNumbers) {
  // existingNumbers: array of ints
  const allowed = getAllAllowedRoomNumbers();
  // pick the smallest allowed number that's not in existingNumbers
  for (const n of allowed) {
    if (!existingNumbers.includes(n)) return n;
  }
  // all used -> return null
  return null;
}

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = (newState?.guild || oldState?.guild);
    if (!guild) return;

    const roomsCategory = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === "Rooms");
    if (!roomsCategory) return;

    // find waiting channel
    const waiting = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.parentId === roomsCategory.id && c.name === "Communication");
    if (!waiting) return;

    // If someone enters any channel: cancel delete timer for that channel if exists
    if (newState && newState.channel) {
      if (autoTimers.has(newState.channel.id)) {
        clearTimeout(autoTimers.get(newState.channel.id));
        autoTimers.delete(newState.channel.id);
      }
    }

    // If someone enters the waiting room, create a new Room
    if (newState && newState.channel && newState.channel.id === waiting.id) {
      const member = newState.member;

      // collect existing Room numbers in this category
      const existingRooms = guild.channels.cache
        .filter(ch => ch.parentId === roomsCategory.id && ch.type === ChannelType.GuildVoice && /^Room\s\d{3}$/.test(ch.name))
        .map(ch => parseInt(ch.name.split(" ")[1], 10));

      const next = pickNextRoomNumber(existingRooms);
      if (!next) {
        // no free rooms
        console.log("⚠️ All Room numbers occupied (101~510)");
        // Optionally notify user
        try { await member.send("All rooms are currently occupied. Please try again later."); } catch(e) {}
        return;
      }

      const newName = `Room ${String(next)}`;

      const newVoice = await guild.channels.create({
        name: newName,
        type: ChannelType.GuildVoice,
        parent: roomsCategory.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ViewChannel] },
        ],
      });

      // Move user
      try {
        await member.voice.setChannel(newVoice);
      } catch (e) {
        console.error("Failed to move member to new room:", e);
      }

      console.log(`➕ Created ${newName} and moved ${member.user.tag}`);

      // schedule auto delete if empty
      const scheduleDelete = (chId) => {
        if (autoTimers.has(chId)) clearTimeout(autoTimers.get(chId));
        const t = setTimeout(async () => {
          const refreshed = guild.channels.cache.get(chId);
          if (refreshed && refreshed.members.size === 0) {
            try {
              await refreshed.delete("Auto cleanup: empty room");
              console.log(`🗑️ Deleted ${refreshed.name}`);
            } catch (e) {
              console.error("Delete failed:", e);
            }
          }
          autoTimers.delete(chId);
        }, AUTO_DELETE_DELAY);
        autoTimers.set(chId, t);
      };

      // if immediately empty (unlikely because we moved someone), schedule deletion anyway
      if (newVoice.members.size === 0) scheduleDelete(newVoice.id);
    }

    // If someone left a room under Rooms category, schedule delete if empty
    if (oldState && oldState.channel && oldState.channel.parentId === roomsCategory.id) {
      const leftCh = guild.channels.cache.get(oldState.channel.id);
      if (leftCh && /^Room\s\d{3}$/.test(leftCh.name) && leftCh.members.size === 0) {
        if (autoTimers.has(leftCh.id)) clearTimeout(autoTimers.get(leftCh.id));
        const t = setTimeout(async () => {
          const refreshed = guild.channels.cache.get(leftCh.id);
          if (refreshed && refreshed.members.size === 0) {
            try {
              await refreshed.delete("Auto cleanup: empty room");
              console.log(`🗑️ Deleted ${refreshed.name}`);
            } catch (e) {
              console.error("Delete failed:", e);
            }
          }
          autoTimers.delete(leftCh.id);
        }, AUTO_DELETE_DELAY);
        autoTimers.set(leftCh.id, t);
      }
    }
  } catch (err) {
    console.error("voiceStateUpdate error:", err);
  }
});

// ---------- Express server for Render heartbeat ----------
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
  await registerGuildCommands(guild.id);
  console.log("🏨 Ardent Hotel Bot Ready!");
});

client.login(TOKEN);
