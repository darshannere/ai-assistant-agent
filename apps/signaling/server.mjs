import { WebSocketServer } from 'ws';
import http from 'http';

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const pingTimeout = 30000;

const port = Number(process.env.PORT) || 4444;
const host = '0.0.0.0';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok\n');
});

const wss = new WebSocketServer({ server });

const topics = new Map();

const send = (conn, message) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    conn.close();
    return;
  }
  try {
    conn.send(JSON.stringify(message));
  } catch (e) {
    conn.close();
  }
};

wss.on('connection', (conn) => {
  const subscribedTopics = new Set();
  let closed = false;
  let pongReceived = true;

  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      conn.close();
      clearInterval(pingInterval);
      return;
    }
    pongReceived = false;
    try {
      conn.ping();
    } catch (e) {
      conn.close();
    }
  }, pingTimeout);

  conn.on('pong', () => {
    pongReceived = true;
  });

  conn.on('close', () => {
    subscribedTopics.forEach((topicName) => {
      const subs = topics.get(topicName);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) topics.delete(topicName);
      }
    });
    subscribedTopics.clear();
    closed = true;
    clearInterval(pingInterval);
  });

  conn.on('message', (raw) => {
    let message = raw;
    if (typeof message === 'string' || message instanceof Buffer) {
      try {
        message = JSON.parse(message.toString());
      } catch {
        return;
      }
    }
    if (!message || !message.type || closed) return;

    switch (message.type) {
      case 'subscribe':
        (message.topics || []).forEach((topicName) => {
          if (typeof topicName !== 'string') return;
          const topic = topics.get(topicName) || new Set();
          topic.add(conn);
          topics.set(topicName, topic);
          subscribedTopics.add(topicName);
        });
        break;
      case 'unsubscribe':
        (message.topics || []).forEach((topicName) => {
          const subs = topics.get(topicName);
          if (subs) subs.delete(conn);
        });
        break;
      case 'publish':
        if (message.topic) {
          const receivers = topics.get(message.topic);
          if (receivers) {
            message.clients = receivers.size;
            receivers.forEach((receiver) => send(receiver, message));
          }
        }
        break;
      case 'ping':
        send(conn, { type: 'pong' });
        break;
    }
  });
});

server.listen(port, host, () => {
  console.log(`y-webrtc signaling server listening on ws://${host}:${port}`);
});
