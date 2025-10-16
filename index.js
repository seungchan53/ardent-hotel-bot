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
fs.ensureDirSync(DATA_DIR);

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ---------- Reaction Role Setup ----------
const roleMessages = {};

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (guild) await setupCheckInReactionRoles(guild);
});

// ✅ check-in 메시지 설정
async function setupCheckInReactionRoles(guild) {
  const channel = guild.channels.cache.find(ch => ch.name.includes("check-in"));
  if (!channel) return console.log("⚠️ check-in 채널을 찾을 수 없습니다.");

  // 기존 메시지 확인
  const messages = await channel.messages.fetch({ limit: 10 });
  const existing = messages.find(m => m.author.id === guild.members.me.id);
  if (existing) {
    roleMessages[guild.id] = existing.id;
    console.log("✅ 기존 check-in 메시지를 사용합니다.");
    return;
  }

  // 새 메시지 생성
  const embed = {
    color: 0xEAB543,
    title: "🏨 Ardent Hotel에 오신 것을 환영합니다!",
    description:
      "체크인하시려면 아래 이모지를 눌러주세요 👇\n\n"
      + "🧍 → **손님 역할 받기**\n\n"
      + "이모지를 누르면 자동으로 손님 역할이 부여되고, 숫자는 자동으로 초기화됩니다.",
    footer: { text: "감사합니다. 좋은 숙박 되세요!" }
  };

  const msg = await channel.send({ embeds: [embed] });
  await msg.react("🧍");

  roleMessages[guild.id] = msg.id;
  console.log("✅ check-in 반응 역할 메시지 생성 완료");
}

// ✅ 반응 처리
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const guild = reaction.message.guild;
    if (!guild) return;

    if (!roleMessages[guild.id] || reaction.message.id !== roleMessages[guild.id]) return;
    if (reaction.emoji.name !== "🧍") return;

    const member = await guild.members.fetch(user.id);

    // ✅ 이름이 정확히 "🛎️ 손님"인 역할만 찾기
    const guestRole = guild.roles.cache.find(r => r.name === "🛎️ 손님");
    if (!guestRole) {
      console.log("⚠️ '🛎️ 손님' 역할을 찾을 수 없습니다.");
      return;
    }

    if (!member.roles.cache.has(guestRole.id)) {
      await member.roles.add(guestRole);
      console.log(`🎉 ${member.user.tag} → 손님 역할 부여 완료`);
    }

    // ✅ 숫자 리셋 (반응 제거)
    const msg = reaction.message;
    const fetchedReaction = msg.reactions.cache.get("🧍");
    if (fetchedReaction) {
      await fetchedReaction.users.remove(user.id).catch(() => {});
      console.log(`🔄 ${user.tag}의 반응 제거 → 숫자 리셋 완료`);
    }
  } catch (err) {
    console.error("❌ Reaction Role Error:", err);
  }
});


// ---------- 나머지 (Rooms 자동 생성/삭제, 서버 구조 등 기존 코드 그대로 유지) ----------
// ⚠️ 아래 부분은 네가 올린 원본 코드 그대로 두면 됨
// ensureServerStructure()
// voiceStateUpdate()
// express 서버 등

// ---------- 봇 준비 시 ----------
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (guild) await setupCheckInReactionRoles(guild);
});


client.login(TOKEN);

