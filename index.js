import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Collection,
} from "discord.js";

import fs from "fs";
import dotenv from "dotenv";
import express from "express";
import { DateTime } from "luxon";

dotenv.config();

// ============== EXPRESS KEEP ALIVE ==============
// Simple HTTP server to keep the bot alive (for hosting platforms like Replit/Heroku)
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("🤖 Discord Boss Tracker Bot is running!");
});

// Status endpoint to check bot uptime and login state
let client; // declared first so it can be used in /status
app.get("/status", (req, res) => {
  res.json({
    status: "online",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    botUser: client?.user ? client.user.tag : "Not logged in",
  });
});

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const clientId = process.env.DISCORD_CLIENT_ID; // Thêm CLIENT_ID vào .env
const TZ = "Asia/Ho_Chi_Minh";

app.listen(PORT, () => {
  console.log("DEBUG TOKEN:", token ? "FOUND ✅" : "MISSING ❌");
  console.log("DEBUG CHANNEL ID:", channelId ? "FOUND ✅" : "MISSING ❌");
  console.log("DEBUG CLIENT ID:", clientId ? "FOUND ✅" : "MISSING ❌");
  console.log(`🌐 HTTP server running on port ${PORT}`);
});

// ============== DISCORD CLIENT ==============
// Create Discord client with necessary intents
client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============== LOAD BOSSES ==============
// Load bosses.json file containing all boss info
let bosses = JSON.parse(fs.readFileSync("bosses.json", "utf8"));

// ============== SLASH COMMAND SETUP ==============
const commands = [
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add boss death time')
    .addStringOption(option =>
      option.setName('boss')
        .setDescription('Type boss name (autocomplete available)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName('death_time')
        .setDescription('Death time in HH:MM format (e.g., 14:30)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('list')
    .setDescription('Show all boss spawn times'),

  new SlashCommandBuilder()
    .setName('mail')
    .setDescription('Get boss list format for mail')
];

// Register slash commands
const rest = new REST({ version: '10' }).setToken(token);

async function registerCommands() {
  try {
    console.log('🔄 Started refreshing slash commands...');

    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );

    console.log('✅ Successfully reloaded slash commands!');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error);
  }
}

// ============== HELPER FUNCS ==============
// Get current datetime in UTC+7 (Vietnam timezone)
function getNowDateUTC7() {
  return DateTime.now().setZone("Asia/Ho_Chi_Minh");
}

// Return sorted list of bosses by next spawn time
function listBosses() {
  let reply = "📆 Next Respawns (UTC+7):\n";

  const sorted = bosses
    .slice()
    .sort(
      (a, b) =>
        DateTime.fromISO(a.spawnAt).toMillis() -
        DateTime.fromISO(b.spawnAt).toMillis()
    );

  for (const b of sorted) {
    const spawnAtVN = DateTime.fromISO(b.spawnAt).setZone(TZ);
    reply += `${b.boss} (${b.rate}%) — ${spawnAtVN.toFormat("HH:mm")} (${b.hours}h)\n`;
  }

  return reply;
}

// Return sorted list of bosses by next spawn time to send mail
function listBossesToSendMail() {
  let reply = "";

  const sorted = bosses
    .slice()
    .sort(
      (a, b) =>
        DateTime.fromISO(a.spawnAt).toMillis() -
        DateTime.fromISO(b.spawnAt).toMillis()
    );

  for (const b of sorted) {
    const spawnAtVN = DateTime.fromISO(b.spawnAt).setZone(TZ);
    reply += `${b.boss} ${spawnAtVN.toFormat("HH:mm")}\n`;
  }

  return reply;
}

// Validate time format HH:MM
function isValidTimeFormat(timeStr) {
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
  return timeRegex.test(timeStr);
}

// Automatically update spawn times if they are in the past
function autoUpdateSpawnTimes() {
  const now = getNowDateUTC7();
  let updated = false;

  bosses.forEach((boss) => {
    if (!boss.spawnAt) return;
    let spawnAt = DateTime.fromISO(boss.spawnAt);

    // Keep adding boss cycle until it's in the future
    while (spawnAt < now) {
      spawnAt = spawnAt.plus({ hours: Number(boss.hours) });
    }

    // If updated, save new time
    if (boss.spawnAt !== spawnAt.toISO()) {
      console.log(
        `🔄 Auto-updated ${boss.boss}: ${DateTime.fromISO(boss.spawnAt).toFormat(
          "HH:mm"
        )} → ${spawnAt.toFormat("HH:mm")}`
      );
      boss.spawnAt = spawnAt.toISO();
      updated = true;
    }
  });

  // Save changes back to bosses.json
  if (updated) {
    fs.writeFileSync("bosses.json", JSON.stringify(bosses, null, 2), "utf8");
  }
  return updated;
}

// Update spawn time of a single boss when user inputs death time
function updateBossSpawn(bossName, deathTime) {
  const boss = bosses.find(
    (b) => b.boss.toLowerCase() === bossName.toLowerCase()
  );
  if (!boss) return { success: false, message: `❌ Boss not found: ${bossName}` };

  // Validate time format
  if (!isValidTimeFormat(deathTime)) {
    return { success: false, message: `❌ Invalid time format! Use HH:MM (e.g., 14:30)` };
  }

  const now = getNowDateUTC7();
  const [dh, dm] = deathTime.split(":").map(Number);
  let deathAt = now.set({ hour: dh, minute: dm, second: 0, millisecond: 0 });

  // If death time is in the future today → treat as yesterday
  if (deathAt > now) {
    deathAt = deathAt.minus({ days: 1 });
  }

  // Spawn time = death time + respawn hours
  const spawnAt = deathAt.plus({ hours: Number(boss.hours) });

  boss.deathAt = deathAt.toISO();
  boss.spawnAt = spawnAt.toISO();

  return {
    success: true,
    message: `✅ **${boss.boss}** - Next spawn: ${spawnAt.toFormat("HH:mm")} (${boss.hours}h respawn)`,
  };
}

// ============== NOTIFICATIONS ==============
// Store which alerts have already been sent to avoid duplicates
let notified = {};
// Check if any boss should trigger an alert
function checkAlerts(channel) {
  const now = getNowDateUTC7();

  autoUpdateSpawnTimes();

  bosses.forEach((boss) => {
    if (!boss.spawnAt) return;
    const spawnAt = DateTime.fromISO(boss.spawnAt).setZone(TZ);
    const diffMinutes = Math.round(spawnAt.diff(now, "minutes").minutes);

    // Predefined alerts (10m, 5m, 1m before spawn)
    const alerts = [
      { offset: 10, message: `⏳ **${boss.boss}** will spawn in 10 minutes!` },
      { offset: 5, message: `⚡ **${boss.boss}** will spawn in 5 minutes!` },
      { offset: 1, message: `🔥 Boss **${boss.boss}** will spawn in 1 minute!` },
    ];

    alerts.forEach((alert) => {
      if (diffMinutes === alert.offset) {
        const key = `${boss.boss}-${alert.offset}-${boss.spawnAt}`;
        if (!notified[key]) {
          channel.send(`${alert.message} at ${spawnAt.toFormat('HH:mm')}`);
          notified[key] = true;
          console.log(`📢 Sent alert: ${alert.message}-${spawnAt.toFormat('HH:mm')}`);
        }
      }
    });
  });

  // Cleanup old alerts (1 lần, không trong forEach)
  const threeHoursAgo = now.minus({ hours: 3 });
  Object.keys(notified).forEach((key) => {
    const spawnAtStr = key.split("-").slice(-1)[0];
    const spawnAt = DateTime.fromISO(spawnAtStr);
    if (spawnAt < threeHoursAgo) {
      delete notified[key];
    }
  });
}

// ============== DISCORD EVENTS ==============
// Bot ready event
client.once("ready", async () => {
  console.log(`✅ Bot logged in as: ${client.user.tag}`);

  // Register slash commands
  await registerCommands();

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.error("❌ Channel not found. Please check the ID.");
    return;
  }

  // Run alert checker every 30 seconds
  setInterval(() => {
    checkAlerts(channel);
  }, 30000);
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
  // Handle autocomplete
  if (interaction.isAutocomplete()) {
    const { commandName, options } = interaction;

    if (commandName === 'add') {
      const focusedValue = options.getFocused().toLowerCase();

      // Filter bosses based on user input
      const filtered = bosses.filter(boss =>
        boss.boss.toLowerCase().includes(focusedValue)
      ).slice(0, 25); // Discord limit is 25 choices

      // Create choices with boss info
      const choices = filtered.map(boss => ({
        name: `${boss.boss} (${boss.rate}% - ${boss.hours}h)`,
        value: boss.boss
      }));

      await interaction.respond(choices);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    if (commandName === 'add') {
      const bossName = interaction.options.getString('boss');
      const deathTime = interaction.options.getString('death_time');

      const result = updateBossSpawn(bossName, deathTime);

      if (!result.success) {
        await interaction.reply({ content: result.message, ephemeral: true });
        return;
      }

      // Save to file
      fs.writeFileSync("bosses.json", JSON.stringify(bosses, null, 2), "utf8");

      // Reply with success message and updated list
      await interaction.reply({
        content: `${result.message}\n\n${listBosses()}`,
        ephemeral: false
      });

    } else if (commandName === 'list') {
      await interaction.reply({
        content: listBosses(),
        ephemeral: false
      });

    } else if (commandName === 'mail') {
      await interaction.reply({
        content: `📧 Boss list for mail:\n\`\`\`\n${listBossesToSendMail()}\`\`\``,
        ephemeral: false
      });
    }

  } catch (error) {
    console.error('Error handling slash command:', error);

    if (!interaction.replied) {
      await interaction.reply({
        content: '❌ An error occurred while processing the command.',
        ephemeral: true
      });
    }
  }
});

// Handle user messages (keep existing message commands for backward compatibility)
client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== channelId) return;

  const content = message.content.trim();

  // Command: !list → Show all boss timers
  if (content === "!list") {
    message.channel.send(listBosses());
    return;
  }

  // Command: !add <boss name> <HH:mm> → Update single boss
  if (content.startsWith("!add ")) {
    const parts = content.split(" ");
    if (parts.length < 3) {
      message.channel.send("❌ Syntax: `!add <boss name> <HH:mm>`");
      return;
    }
    const deathTime = parts[parts.length - 1];
    const bossName = parts.slice(1, -1).join(" ");

    const result = updateBossSpawn(bossName, deathTime);

    if (!result.success) {
      message.channel.send(result.message);
      return;
    }

    fs.writeFileSync("bosses.json", JSON.stringify(bosses, null, 2), "utf8");
    message.channel.send(result.message);
    message.channel.send(listBosses());
  }

  // Command: !addmulti → Add multiple bosses at once
  if (content.startsWith("!addmulti")) {
    const lines = content.split("\n").slice(1); // skip first line with command
    let results = [];

    for (const line of lines) {
      const parts = line.trim().split(" ");
      if (parts.length < 2) continue;

      const deathTime = parts[parts.length - 1];
      const bossName = parts.slice(0, -1).join(" ");
      const result = updateBossSpawn(bossName, deathTime);
      results.push(result.message);
    }

    fs.writeFileSync("bosses.json", JSON.stringify(bosses, null, 2), "utf8");
    message.channel.send(results.join("\n"));
    message.channel.send(listBosses());
  }

  // Command: !mail → list boss spawn to send mail
  if (content.startsWith("!mail")) {
    message.channel.send(listBossesToSendMail());
  }
});

// ============== LOGIN ==============
// Start bot
client.login(token).catch((err) => {
  console.log("DEBUG TOKEN:", token ? "FOUND ✅" : "MISSING ❌");
  console.log("DEBUG CHANNEL ID:", channelId ? "FOUND ✅" : "MISSING ❌");
  console.log("DEBUG CLIENT ID:", clientId ? "FOUND ✅" : "MISSING ❌");
  console.error("❌ Failed to login:", err);
});