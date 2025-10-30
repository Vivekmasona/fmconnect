// BiharFM WebRTC Tree Signaling Server
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";

const app = express();
app.get("/", (req, res) => {
  res.send("🎧 BiharFM Signaling Server is Live!");
});

// Render gives PORT via env
const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------------------
// Active connections & Rooms
// ---------------------------
const clients = new Map(); // id -> ws
const rooms = new Map();   // roomId -> { host: id, listeners: [] }

// Helper: safe send
function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Broadcast metadata to listeners in a room
function broadcastMetadata(roomId, meta) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const listenerId of room.listeners) {
    const listener = clients.get(listenerId);
    if (listener) send(listener, { type: "metadata", ...meta });
  }
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  clients.set(id, ws);
  ws.id = id;
  ws.role = null;
  ws.roomId = null;

  console.log("🔗 Client connected:", id);

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      // Host or Listener registration
      if (data.type === "register") {
        const { role, room } = data;
        ws.role = role;
        ws.roomId = room || "main";

        // create room if not exist
        if (!rooms.has(ws.roomId))
          rooms.set(ws.roomId, { host: null, listeners: [] });

        const r = rooms.get(ws.roomId);

        if (role === "host") {
          r.host = id;
          send(ws, { type: "registered", id, room: ws.roomId });
          console.log(`🎙️ Host joined room ${ws.roomId}`);
        } else if (role === "listener") {
          r.listeners.push(id);
          send(ws, { type: "registered", id, room: ws.roomId });
          console.log(`🎧 Listener joined ${ws.roomId}`);
        }
      }

      // WebRTC Offer/Answer/Candidate
      if (["offer", "answer", "candidate"].includes(data.type)) {
        const target = clients.get(data.target);
        if (target) send(target, data);
      }

      // Host sends metadata updates
      if (data.type === "metadata") {
        broadcastMetadata(ws.roomId, data);
      }
    } catch (err) {
      console.error("❌ Invalid message:", err);
    }
  });

  ws.on("close", () => {
    clients.delete(id);
    if (ws.roomId && rooms.has(ws.roomId)) {
      const room = rooms.get(ws.roomId);
      if (ws.role === "host") {
        room.host = null;
        console.log(`🚫 Host left ${ws.roomId}`);
      } else {
        room.listeners = room.listeners.filter((l) => l !== id);
      }
    }
  });
});

server.listen(PORT, () => console.log("🚀 Server running on port", PORT));
