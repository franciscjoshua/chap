// signaling.mjs
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 4444 });
const topics = new Map();

wss.on('connection', (conn) => {
  const subscribedTopics = new Set();
  let closed = false;

  // Respond to ping messages to keep connection alive
  conn.on('message', (message) => {
    const data = JSON.parse(message.toString());
    if (data && data.type === 'ping') {
      conn.send(JSON.stringify({ type: 'pong' }));
    }
    if (data && data.type === 'subscribe') {
      (data.topics || []).forEach((topicName) => {
        subscribedTopics.add(topicName);
        if (!topics.has(topicName)) topics.set(topicName, new Set());
        topics.get(topicName).add(conn);
      });
    }
    if (data && data.type === 'publish' && data.topic) {
      const receivers = topics.get(data.topic);
      if (receivers) {
        data.clients = receivers.size;
        receivers.forEach((receiver) => {
          if (receiver !== conn) receiver.send(JSON.stringify(data));
        });
      }
    }
  });

  conn.on('close', () => {
    subscribedTopics.forEach((topicName) => {
      const subs = topics.get(topicName);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) topics.delete(topicName);
      }
    });
    closed = true;
  });
});

console.log('✅ P2P Signaling Server running on ws://localhost:4444');
