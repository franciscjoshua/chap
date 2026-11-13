// server.mjs
import { WebSocketServer } from 'ws';
import * as ed from '@noble/ed25519';
import crypto from 'crypto';

const PORT = 8080;
const SERVER_NAME = "Josh's Test Server";

// Optional Whitelist: If empty, anyone can join. 
// If you put Public IDs in here, ONLY those accounts can join!
const WHITELIST = [
  // "273439893420a303661f..." 
];

const wss = new WebSocketServer({ port: PORT });

// Track connected clients and in-memory chat history
const clients = new Map(); // ws -> { publicKey, username, bio }
const messages = [];       // Array of recent messages

function broadcast(packet) {
  const data = JSON.stringify(packet);
  for (const [clientWs] of clients) {
    if (clientWs.readyState === 1) clientWs.send(data);
  }
}

function broadcastUserList() {
  // Deduplicate by publicKey in case the same user has both Phone & PC connected!
  const uniqueUsers = new Map();
  for (const [, user] of clients) {
    uniqueUsers.set(user.publicKey, user);
  }
  broadcast({ type: 'USER_LIST', users: Array.from(uniqueUsers.values()) });
}

wss.on('connection', (ws) => {
  // Step 1: Send a random cryptographic challenge to the connecting client
  const challenge = crypto.randomBytes(32).toString('hex');
  ws.send(JSON.stringify({ 
    type: 'AUTH_CHALLENGE', 
    challenge, 
    serverName: SERVER_NAME 
  }));

  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      // Step 2: Verify the client's cryptographic signature
      if (data.type === 'AUTH_RESPONSE') {
        const { publicKey, signature, username, bio } = data;

        // Check Whitelist (if enabled)
        if (WHITELIST.length > 0 && !WHITELIST.includes(publicKey)) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'You are not whitelisted on this server.' }));
          return ws.close();
        }

        // Mathematically verify they own the Private Key for this Public Key
        const isValid = await ed.verifyAsync(signature, challenge, publicKey);
        if (!isValid) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid cryptographic signature!' }));
          return ws.close();
        }

        // Auth succeeded! Save their profile on the server
        clients.set(ws, { publicKey, username: username || 'Anonymous', bio: bio || '' });

        // Send them the chat history and updated member list
        ws.send(JSON.stringify({ type: 'INIT_STATE', serverName: SERVER_NAME, messages }));
        broadcastUserList();
        return;
      }

      // Reject anything else if not authenticated yet
      const user = clients.get(ws);
      if (!user) return;

      // Step 3: Handle Live Profile Updates (when user edits their bio/name on ANY device)
      if (data.type === 'PROFILE_UPDATE') {
        user.username = data.username || 'Anonymous';
        user.bio = data.bio || '';
        broadcastUserList();
      }

      // Step 4: Handle Chat Messages
      if (data.type === 'CHAT_MESSAGE' && data.text?.trim()) {
        const msg = {
          id: crypto.randomUUID(),
          senderKey: user.publicKey,
          senderName: user.username,
          text: data.text.trim(),
          timestamp: Date.now()
        };
        messages.push(msg);
        if (messages.length > 100) messages.shift(); // Keep last 100 messages
        broadcast({ type: 'NEW_MESSAGE', message: msg });
      }
    } catch (err) {
      console.error('Failed to process message:', err);
    }
  });

  ws.on('close', () => {
    if (clients.has(ws)) {
      clients.delete(ws);
      broadcastUserList();
    }
  });
});

console.log(`🏰 Minecraft-style Chat Server "${SERVER_NAME}" running on ws://localhost:${PORT}`);
