// signaling-server.js
import WebSocket, { WebSocketServer } from "ws";
import http from "http";

const port = 4444;
const server = http.createServer();
const wss = new WebSocketServer({ server });

// Map of roomName -> Set of WebSocket connections
const rooms = new Map();

wss.on("connection", (ws, req) => {
  const room = req.url.slice(1) || "default";
  console.log(`🟢 Client joined room: ${room}`);

  if (!rooms.has(room)) rooms.set(room, new Set());
  const clients = rooms.get(room);
  clients.add(ws);

  ws.on("message", (message) => {
    for (const client of clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });

  ws.on("close", () => {
    console.log(`🔴 Client left room: ${room}`);
    clients.delete(ws);
    if (clients.size === 0) rooms.delete(room);
  });
});

server.listen(port, () => {
  console.log(`✅ Local Yjs signaling server running at ws://localhost:${port}`);
});