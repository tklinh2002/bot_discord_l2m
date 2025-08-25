import { Client, GatewayIntentBits } from "discord.js";
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

app.listen(PORT, () => {
  console.log("DEBUG TOKEN:", token ? "FOUND ✅" : "MISSING ❌");
  console.log("DEBUG CHANNEL ID:", channelId ? "FOUND ✅" : "MISSING ❌");
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

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;

// ============== LOAD BOSSES ==============
// Load bosses.json file containing all boss info
let bosses = JSON.parse(fs.readFileSync("bosses.json", "utf8"));

// ============== HELPER FUNCS ==============
// Get current datetime in UTC+7 (Vietnam timezone)
function getNowDateUTC7() {
  return DateTime.now().setZone("Asia/Ho_Chi_Minh");
}

// Return sorted list of bosses by next spawn time
function listBosses() {
  const TZ = "Asia/Ho_Chi_Minh";
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
    message: `✅ **${boss.boss}** - ${spawnAt.toFormat("HH:mm")}`,
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
    const spawnAt = DateTime.fromISO(boss.spawnAt);
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
          channel.send(alert.message);
          notified[key] = true;
          console.log(`📢 Sent alert: ${alert.message}`);
        }}
    });

    // Cleanup old alerts (older than 1 days)
    const twoDaysAgo = now.minus({ days: 1 }).toISODate();
    Object.keys(notified).forEach((key) => {
      const day = key.split("-").pop();
      if (day < twoDaysAgo) {
        delete notified[key];
      }
    });
  });
}

// ============== DISCORD EVENTS ==============
// Bot ready event
client.once("ready", () => {
  console.log(`✅ Bot logged in as: ${client.user.tag}`);

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

// Handle user messages
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
  
});

// ============== LOGIN ==============
// Start bot

client.login(token).catch((err) => {
  console.log("DEBUG TOKEN:", token ? "FOUND ✅" : "MISSING ❌");
  console.log("DEBUG CHANNEL ID:", channelId ? "FOUND ✅" : "MISSING ❌");
  console.error("❌ Failed to login:", err);
});
