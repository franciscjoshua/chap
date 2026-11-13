import { WebSocketServer } from 'ws';
import * as ed from '@noble/ed25519';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || './data';

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {}

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const DMS_FILE = path.join(DATA_DIR, 'dms.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const SNAPSHOTS_FILE = path.join(DATA_DIR, 'snapshots.json');

function safeReadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {}
  return fallback;
}

function safeWriteJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {}
}

let config = safeReadJson(CONFIG_FILE, {
  serverName: process.env.SERVER_NAME || "Josh's Minecraft-Style Server",
  channels: ['general', 'gaming', 'off-topic'],
  allowSnapshots: true,
  whitelistEnabled: false,
  whitelist: [],
  blacklist: [],
  admins: [] // Public IDs of Server Operators
});

let messages = safeReadJson(MESSAGES_FILE, []);
let dms = safeReadJson(DMS_FILE, []);
let profiles = safeReadJson(PROFILES_FILE, {}); // publicKey -> { username, bio, avatar, friends, joinedAt }
let snapshots = safeReadJson(SNAPSHOTS_FILE, {}); // publicKey -> encryptedHexBlob
let stats = safeReadJson(STATS_FILE, {
  largestVoiceCall: 0,
  longestVoiceCallSeconds: 0,
  serverStreaks: {}, // publicKey -> { count, lastDate }
  dmStreaks: {}      // sortedPairKey -> { count, lastDate, lastSender }
});

function saveConfig() { safeWriteJson(CONFIG_FILE, config); }
function saveProfiles() { safeWriteJson(PROFILES_FILE, profiles); }
function saveStats() { safeWriteJson(STATS_FILE, stats); }

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

const wss = new WebSocketServer({ port: PORT, maxPayload: 5 * 1024 * 1024 });
const clients = new Map();
const rateLimits = new Map();
let voiceCallStartTime = null;

// Interactive Server Console (Type "op <publicKey>" just like Minecraft!)
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const targetKey = parts[1];

  if (cmd === 'op' && targetKey) {
    if (!config.admins.includes(targetKey)) {
      config.admins.push(targetKey);
      saveConfig();
      console.log(`✅ Granted Operator/Admin to ${targetKey}`);
      broadcastStateLists();
    }
  } else if (cmd === 'deop' && targetKey) {
    config.admins = config.admins.filter(k => k !== targetKey);
    saveConfig();
    console.log(`❌ Removed Operator/Admin from ${targetKey}`);
    broadcastStateLists();
  } else if (cmd === 'snapshots') {
    config.allowSnapshots = !config.allowSnapshots;
    saveConfig();
    console.log(`☁️ Encrypted Snapshots Allowed: ${config.allowSnapshots}`);
    broadcastStateLists();
  } else {
    console.log(`Commands: op <publicKey> | deop <publicKey> | snapshots`);
  }
});

setInterval(() => {
  if (voiceCallStartTime) {
    const elapsed = Math.floor((Date.now() - voiceCallStartTime) / 1000);
    if (elapsed > stats.longestVoiceCallSeconds) {
      stats.longestVoiceCallSeconds = elapsed;
      saveStats();
      broadcast({ type: 'STATS_UPDATE', stats });
    }
  }
}, 2000);

function checkRateLimit(publicKey) {
  const now = Date.now();
  const recent = (rateLimits.get(publicKey) || []).filter(t => now - t < 4000);
  if (recent.length >= 6) return false;
  recent.push(now);
  rateLimits.set(publicKey, recent);
  return true;
}

function updateServerStreak(publicKey) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (!stats.serverStreaks) stats.serverStreaks = {};
  const cur = stats.serverStreaks[publicKey] || { count: 0, lastDate: '' };
  if (cur.lastDate === today) return;
  cur.count = (cur.lastDate === yesterday) ? cur.count + 1 : 1;
  cur.lastDate = today;
  stats.serverStreaks[publicKey] = cur;
  saveStats();
}

function updateDmStreak(senderKey, targetKey) {
  const pairKey = [senderKey, targetKey].sort().join('-');
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (!stats.dmStreaks) stats.dmStreaks = {};
  const cur = stats.dmStreaks[pairKey] || { count: 0, lastDate: '' };

  if (cur.lastDate === today) return;
  cur.count = (cur.lastDate === yesterday) ? cur.count + 1 : 1;
  cur.lastDate = today;
  stats.dmStreaks[pairKey] = cur;
  saveStats();
}

function broadcast(packet) {
  const data = JSON.stringify(packet);
  for (const [clientWs] of clients) {
    if (clientWs.readyState === 1) clientWs.send(data);
  }
}

function broadcastStateLists() {
  const uniqueUsers = new Map();
  const voiceUsers = [];

  for (const [, user] of clients) {
    uniqueUsers.set(user.publicKey, {
      publicKey: user.publicKey,
      username: user.username,
      bio: user.bio,
      avatar: user.avatar
    });
    if (user.inVoice && !voiceUsers.includes(user.publicKey)) {
      voiceUsers.push(user.publicKey);
    }
  }

  if (voiceUsers.length > stats.largestVoiceCall) {
    stats.largestVoiceCall = voiceUsers.length;
    saveStats();
  }
  if (voiceUsers.length > 0 && !voiceCallStartTime) voiceCallStartTime = Date.now();
  else if (voiceUsers.length === 0) voiceCallStartTime = null;

  broadcast({ 
    type: 'USER_LIST', 
    users: Array.from(uniqueUsers.values()),
    profiles,
    voiceUsers,
    stats,
    serverConfig: {
      serverName: config.serverName,
      channels: config.channels,
      allowSnapshots: config.allowSnapshots,
      whitelistEnabled: config.whitelistEnabled,
      whitelist: config.whitelist,
      blacklist: config.blacklist,
      admins: config.admins
    }
  });
}

wss.on('connection', (ws) => {
  const challenge = crypto.randomBytes(32).toString('hex');
  ws.send(JSON.stringify({ type: 'AUTH_CHALLENGE', challenge, serverName: config.serverName }));

  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === 'AUTH_RESPONSE') {
        const { publicKey, signature, username, bio, avatar, friends } = data;

        if (config.blacklist.includes(publicKey)) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'You are banned/blacklisted from this server.' }));
          return ws.close();
        }
        if (config.whitelistEnabled && !config.whitelist.includes(publicKey) && !config.admins.includes(publicKey)) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Whitelist is enabled on this server.' }));
          return ws.close();
        }

        const isValid = await ed.verifyAsync(
          hexToBytes(signature),
          hexToBytes(challenge),
          hexToBytes(publicKey)
        );
        if (!isValid) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid signature!' }));
          return ws.close();
        }

        // Auto-OP the very first user on a brand new server so you don't even have to use the console!
        if (config.admins.length === 0) {
          config.admins.push(publicKey);
          saveConfig();
          console.log(`👑 Auto-granted Server Owner/Admin to first user: ${publicKey}`);
        }

        const existingProfile = profiles[publicKey] || {};
        const joinedAt = existingProfile.joinedAt || Date.now();

        const userProfile = {
          publicKey,
          username: (username || 'Anonymous').slice(0, 32),
          bio: (bio || '').slice(0, 160),
          avatar: avatar || '',
          friends: Array.isArray(friends) ? friends : (existingProfile.friends || []),
          joinedAt,
          inVoice: false
        };

        clients.set(ws, userProfile);
        profiles[publicKey] = {
          username: userProfile.username,
          bio: userProfile.bio,
          avatar: userProfile.avatar,
          friends: userProfile.friends,
          joinedAt
        };
        saveProfiles();
        updateServerStreak(publicKey);

        const myDms = dms.filter(m => m.senderKey === publicKey || m.targetKey === publicKey);

        ws.send(JSON.stringify({ 
          type: 'INIT_STATE', 
          serverName: config.serverName, 
          channels: config.channels,
          messages: messages.slice(-100),
          dms: myDms,
          profiles,
          stats,
          encryptedSnapshot: config.allowSnapshots ? (snapshots[publicKey] || null) : null,
          serverConfig: {
            serverName: config.serverName,
            channels: config.channels,
            allowSnapshots: config.allowSnapshots,
            whitelistEnabled: config.whitelistEnabled,
            whitelist: config.whitelist,
            blacklist: config.blacklist,
            admins: config.admins
          }
        }));
        broadcastStateLists();
        return;
      }

      const user = clients.get(ws);
      if (!user) return;

      if (['CHAT_MESSAGE', 'DIRECT_MESSAGE'].includes(data.type) && !checkRateLimit(user.publicKey)) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Slow down! Sending messages too fast.' }));
        return;
      }

      if (data.type === 'PROFILE_UPDATE') {
        user.username = (data.username || 'Anonymous').slice(0, 32);
        user.bio = (data.bio || '').slice(0, 160);
        user.avatar = data.avatar || '';
        if (Array.isArray(data.friends)) user.friends = data.friends;

        profiles[user.publicKey] = {
          ...profiles[user.publicKey],
          username: user.username,
          bio: user.bio,
          avatar: user.avatar,
          friends: user.friends
        };
        saveProfiles();
        broadcastStateLists();
      }

      // Feature: Encrypted Binary Snapshot Upload (If allowed by Server + User!)
      if (data.type === 'SAVE_SNAPSHOT' && config.allowSnapshots && data.encryptedHex) {
        snapshots[user.publicKey] = data.encryptedHex;
        safeWriteJson(SNAPSHOTS_FILE, snapshots);
      }

      // Feature: Admin Panel Controls (Only allowed if user is in config.admins!)
      if (data.type === 'ADMIN_ACTION' && config.admins.includes(user.publicKey)) {
        if (data.action === 'SET_SERVER_NAME' && data.serverName?.trim()) {
          config.serverName = data.serverName.trim();
        }
        if (data.action === 'ADD_CHANNEL' && data.channel?.trim()) {
          const ch = data.channel.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
          if (ch && !config.channels.includes(ch)) config.channels.push(ch);
        }
        if (data.action === 'REMOVE_CHANNEL' && config.channels.length > 1) {
          config.channels = config.channels.filter(c => c !== data.channel);
        }
        if (data.action === 'TOGGLE_SNAPSHOTS') {
          config.allowSnapshots = !config.allowSnapshots;
        }
        if (data.action === 'TOGGLE_WHITELIST') {
          config.whitelistEnabled = !config.whitelistEnabled;
        }
        if (data.action === 'ADD_ADMIN' && data.targetKey) {
          if (!config.admins.includes(data.targetKey)) config.admins.push(data.targetKey);
        }
        if (data.action === 'BAN_USER' && data.targetKey && data.targetKey !== user.publicKey) {
          if (!config.blacklist.includes(data.targetKey)) config.blacklist.push(data.targetKey);
          for (const [cWs, cUser] of clients) {
            if (cUser.publicKey === data.targetKey) cWs.close();
          }
        }
        if (data.action === 'UNBAN_USER' && data.targetKey) {
          config.blacklist = config.blacklist.filter(k => k !== data.targetKey);
        }
        saveConfig();
        broadcastStateLists();
      }

      if (data.type === 'CHAT_MESSAGE' && data.text?.trim()) {
        updateServerStreak(user.publicKey);
        const msg = {
          id: crypto.randomUUID(),
          channel: data.channel || 'general',
          senderKey: user.publicKey,
          senderName: user.username,
          senderAvatar: user.avatar,
          text: data.text.trim(),
          timestamp: Date.now()
        };
        messages.push(msg);
        if (messages.length > 500) messages.shift();
        safeWriteJson(MESSAGES_FILE, messages);
        broadcast({ type: 'NEW_MESSAGE', message: msg });
        broadcast({ type: 'STATS_UPDATE', stats });
      }

      // Allow Sender OR Server Admin to delete messages!
      if (data.type === 'DELETE_MESSAGE' && data.messageId) {
        const isAdmin = config.admins.includes(user.publicKey);
        const idx = messages.findIndex(m => m.id === data.messageId && (m.senderKey === user.publicKey || isAdmin));
        if (idx !== -1) {
          messages.splice(idx, 1);
          safeWriteJson(MESSAGES_FILE, messages);
          broadcast({ type: 'MESSAGE_DELETED', messageId: data.messageId });
        }
        const dmIdx = dms.findIndex(m => m.id === data.messageId && m.senderKey === user.publicKey);
        if (dmIdx !== -1) {
          dms.splice(dmIdx, 1);
          safeWriteJson(DMS_FILE, dms);
          broadcast({ type: 'DM_DELETED', messageId: data.messageId });
        }
      }

      if (data.type === 'DIRECT_MESSAGE' && data.targetKey && data.text?.trim()) {
        updateDmStreak(user.publicKey, data.targetKey);
        const dmMsg = {
          id: crypto.randomUUID(),
          senderKey: user.publicKey,
          targetKey: data.targetKey,
          text: data.text.trim(),
          timestamp: Date.now()
        };
        dms.push(dmMsg);
        if (dms.length > 500) dms.shift();
        safeWriteJson(DMS_FILE, dms);

        for (const [clientWs, otherUser] of clients) {
          if ((otherUser.publicKey === data.targetKey || otherUser.publicKey === user.publicKey) && clientWs.readyState === 1) {
            clientWs.send(JSON.stringify({ type: 'NEW_DM', message: dmMsg }));
            clientWs.send(JSON.stringify({ type: 'STATS_UPDATE', stats }));
          }
        }
      }

      if (data.type === 'VOICE_JOIN') {
        user.inVoice = true;
        broadcastStateLists();
        for (const [clientWs, otherUser] of clients) {
          if (clientWs !== ws && otherUser.inVoice && clientWs.readyState === 1) {
            clientWs.send(JSON.stringify({ type: 'VOICE_PEER_JOINED', peerKey: user.publicKey }));
          }
        }
      }

      if (data.type === 'VOICE_LEAVE') {
        user.inVoice = false;
        broadcastStateLists();
      }

      if (data.type === 'VOICE_SIGNAL' && data.targetKey) {
        for (const [clientWs, otherUser] of clients) {
          if (otherUser.publicKey === data.targetKey && clientWs.readyState === 1) {
            clientWs.send(JSON.stringify({
              type: 'VOICE_SIGNAL',
              fromKey: user.publicKey,
              signal: data.signal
            }));
          }
        }
      }
    } catch (err) {
      console.error('Server error:', err);
    }
  });

  ws.on('close', () => {
    if (clients.has(ws)) {
      clients.delete(ws);
      broadcastStateLists();
    }
  });
});

console.log(`🐳 Chap Server "${config.serverName}" listening on ws://0.0.0.0:${PORT}`);
console.log(`💡 Console commands: op <publicKey> | deop <publicKey> | snapshots`);
