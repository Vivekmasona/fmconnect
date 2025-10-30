// server.js — FM Room Signaling with auto 2-listener groups
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get("/", (req, res) => res.send("🎧 Bihar FM Room Server is running"));

// --- Data Structures ---
let broadcaster = null;
let listeners = new Map(); // id -> ws
let rooms = []; // [{ id: "fm1234", members: [listenerIds] }]

// --- Utility ---
function createRoomId() {
  return "fm" + Math.floor(1000 + Math.random() * 90000);
}
function getOrCreateRoom() {
  let room = rooms.find(r => r.members.length < 2);
  if (!room) {
    room = { id: createRoomId(), members: [] };
    rooms.push(room);
  }
  return room;
}
function broadcastTo(ws, data) {
  if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

// --- WebSocket Connections ---
wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  ws.id = id;

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      // --- Register broadcaster ---
      if (data.type === "register" && data.role === "broadcaster") {
        broadcaster = ws;
        broadcastTo(ws, { type: "registered", role: "broadcaster" });
        console.log("🎙️ Broadcaster connected:", id);
      }

      // --- Register listener ---
      else if (data.type === "register" && data.role === "listener") {
        listeners.set(id, ws);
        const room = getOrCreateRoom();
        room.members.push(id);
        ws.roomId = room.id;
        broadcastTo(ws, { type: "room-joined", roomId: room.id });
        console.log(`👂 Listener joined room ${room.id} (${room.members.length}/2)`);

        // Notify broadcaster about new listener
        if (broadcaster)
          broadcastTo(broadcaster, { type: "listener-joined", id });
      }

      // --- Relay signaling ---
      else if (data.type === "offer" && data.target) {
        const target = listeners.get(data.target);
        if (target) broadcastTo(target, { type: "offer", from: id, payload: data.payload });
      } else if (data.type === "answer" && broadcaster) {
        broadcastTo(broadcaster, { type: "answer", from: id, payload: data.payload });
      } else if (data.type === "candidate") {
        if (data.target && broadcaster && data.role === "broadcaster") {
          const target = listeners.get(data.target);
          if (target) broadcastTo(target, { type: "candidate", from: id, payload: data.payload });
        } else if (broadcaster && data.role === "listener") {
          broadcastTo(broadcaster, { type: "candidate", from: id, payload: data.payload });
        }
      }

      // --- Metadata broadcast ---
      else if (data.type === "metadata") {
        // Send metadata to all listeners
        for (const l of listeners.values())
          broadcastTo(l, { type: "metadata", payload: data.payload });
      }
    } catch (e) {
      console.warn("WS parse error:", e);
    }
  });

  ws.on("close", () => {
    if (broadcaster === ws) {
      broadcaster = null;
      console.log("❌ Broadcaster disconnected");
    } else {
      listeners.delete(id);
      rooms.forEach(r => (r.members = r.members.filter(m => m !== id)));
      rooms = rooms.filter(r => r.members.length > 0);
      if (broadcaster)
        broadcastTo(broadcaster, { type: "peer-left", id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("✅ Server running on port", PORT));
