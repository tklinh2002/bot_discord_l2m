import { Client, GatewayIntentBits } from "discord.js";
import fs from "fs";
import dotenv from "dotenv";
import express from 'express';
import { DateTime } from "luxon";

dotenv.config();

// Express server để keep alive
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Discord Boss Tracker Bot is running!');
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    botUser: client.user ? client.user.tag : 'Not logged in'
  });
});

app.listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;

// Load bosses.json
let bosses = JSON.parse(fs.readFileSync("bosses.json", "utf8"));

// Convert "HH:mm" to total minutes
function timeToMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// Generate formatted boss list
function listBosses() {
  const now = getNowDateUTC7()
  const currentMinutes = now.hour * 60 + now.minute;

  let reply = "📆 Next Respawns:\n";

  bosses
    .slice()
    .sort((a, b) => {
      const aMinutes = timeToMinutes(a.spawn);
      const bMinutes = timeToMinutes(b.spawn);
      const aDiff = (aMinutes - currentMinutes + 1440) % 1440;
      const bDiff = (bMinutes - currentMinutes + 1440) % 1440;

      return aDiff - bDiff;
    })
    .forEach((b) => {
      reply += `${b.boss} (${b.rate}%) — ${b.spawn} (${b.hours}h)\n`;
    });

  return reply;
}
function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// Auto-update boss spawn times if they have already passed
function autoUpdateSpawnTimes() {
  const now = getNowDateUTC7()
  console.log('now',now)
  const currentMinutes = now.hour * 60 + now.minute;
  let updated = false;

  bosses.forEach((boss) => {
    const spawnMinutes = timeToMinutes(boss.spawn);
    
    // Check if spawn time has passed
    if (currentMinutes > spawnMinutes) {
      // Calculate how many cycles have passed
      const timePassed = currentMinutes - spawnMinutes;
      const cycleMinutes = boss.hours * 60;
      const cyclesPassed = Math.floor(timePassed / cycleMinutes) + 1;
      
      // Calculate next spawn time
      let nextSpawnMinutes = spawnMinutes + (cyclesPassed * cycleMinutes);
      nextSpawnMinutes = nextSpawnMinutes % (24 * 60); // wrap to 24h
      
      // Update boss spawn time
      const newSpawnTime = minutesToTime(nextSpawnMinutes);
      if (boss.spawn !== newSpawnTime) {
        console.log(`🔄 Auto-updated ${boss.boss}: ${boss.spawn} → ${newSpawnTime}`);
        boss.spawn = newSpawnTime;
        updated = true;
      }
    }
  });

  // Save to file if any updates were made
  if (updated) {
    fs.writeFileSync("bosses.json", JSON.stringify(bosses, null, 2), "utf8");
  }

  return updated;
}

// =======================
// Shared update function
// =======================
function updateBossSpawn(bossName, deathTime) {
  // Find boss by name (case insensitive)
  const boss = bosses.find(
    (b) => b.boss.toLowerCase() === bossName.toLowerCase()
  );
  if (!boss) {
    return { success: false, message: `❌ Boss not found: ${bossName}` };
  }

  // Convert death time into minutes
  const [dh, dm] = deathTime.split(":").map(Number);
  const deathMinutes = dh * 60 + dm;

  // Add respawn hours
  let spawnMinutes = deathMinutes + boss.hours * 60;
  spawnMinutes = spawnMinutes % (24 * 60); // wrap to 24h

  // Format back into "HH:mm"
  const spawnH = String(Math.floor(spawnMinutes / 60)).padStart(2, "0");
  const spawnM = String(spawnMinutes % 60).padStart(2, "0");
  boss.spawn = `${spawnH}:${spawnM}`;

  return {
    success: true,
    message: `✅**${boss.boss}** - ${boss.spawn}`,
  };
}


function getNowDateUTC7() {
  const nowVN = DateTime.now().setZone('Asia/Ho_Chi_Minh');
  return nowVN
}

// Prevent duplicate notifications
let notified = {};

client.once("ready", () => {
  console.log(`✅ Bot logged in as: ${client.user.tag}`);

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.error("❌ Channel not found. Please check the ID.");
    return;
  }

  // Check spawn alerts every 10 seconds
  // Check spawn alerts and auto-update every 30 seconds
  setInterval(() => {
    const now = getNowDateUTC7()
    const currentMinutes = now.hour * 60 + now.minute;

    // Auto-update spawn times every check
    autoUpdateSpawnTimes();

    bosses.forEach((boss) => {
      const spawnMinutes = timeToMinutes(boss.spawn);

      // Define alerts
      const alerts = [
        { offset: 10, message: `⏳ **${boss.boss}** will spawn in 10 minutes!` },
        { offset: 5, message: `⚡ **${boss.boss}** will spawn in 5 minutes!` },
        { offset: 1, message: `🔥 Boss **${boss.boss}** will spawn in 1 minute!` },
      ];

      alerts.forEach((alert) => {
        // Calculate target minute for notification
        let targetMinute = spawnMinutes - alert.offset;
        
        // Handle negative values (cross-day scenarios)
        if (targetMinute < 0) {
          targetMinute += 1440; // Add 24 hours in minutes
        }

        // Calculate time difference accounting for day wrap
        let timeDiff = Math.abs(currentMinutes - targetMinute);
        
        // Handle day boundary crossing
        if (timeDiff > 720) { // More than 12 hours difference
          timeDiff = 1440 - timeDiff;
        }

        // Send notification if within 1 minute of target time
        if (timeDiff <= 0.5) { // 30 seconds tolerance
          const dateKey = Math.floor(now.toMillis() / (24 * 60 * 60 * 1000));
          const key = `${boss.boss}-${alert.offset}-${dateKey}`;

          if (!notified[key]) {
            channel.send(alert.message);
            notified[key] = true;
            console.log(`📢 Sent alert: ${alert.message}`);
          }
        }
      });
    });

    // Clean up old notification keys every hour (when minutes = 0)
    if (now.minute === 0) {
      const twoDaysAgo = Math.floor(Date.now() / (24 * 60 * 60 * 1000)) - 2;
      Object.keys(notified).forEach(key => {
        const keyParts = key.split('-');
        const keyDay = parseInt(keyParts[keyParts.length - 1]);
        if (keyDay < twoDaysAgo) {
          delete notified[key];
        }
      });
      console.log('🧹 Cleaned up old notification keys');
    }
  }, 30000);
});

// =======================
// Chat Commands
// =======================
client.on("messageCreate", (message) => {
  if (message.author.bot) return;

  if (message.channel.id !== channelId) return;
  
  const content = message.content.trim();

  // Command: !list → show all bosses
  if (content === "!list") {
    message.channel.send(listBosses());
    return;
  }

  // Command: !add <boss name> <HH:mm>
  if (content.startsWith("!add ")) {
    const parts = content.trim().split(" ");
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

    // Save bosses.json
    fs.writeFileSync("bosses.json", JSON.stringify(bosses, null, 2), "utf8");

    message.channel.send(result.message);
    message.channel.send(listBosses());
  }

  // Command: !addmulti (multiple bosses at once)
  if (content.startsWith("!addmulti")) {
    const lines = content.split("\n").slice(1); // skip the first line
    let results = [];

    for (const line of lines) {
      const parts = line.trim().split(" ");
      if (parts.length < 2) continue;

      const deathTime = parts[parts.length - 1];
      const bossName = parts.slice(0, -1).join(" ");

      const result = updateBossSpawn(bossName, deathTime);
      results.push(result.message);
    }

    // Save bosses.json
    fs.writeFileSync("bosses.json", JSON.stringify(bosses, null, 2), "utf8");

    message.channel.send(results.join("\n"));
    message.channel.send(listBosses());
  }
});

client.login(token);