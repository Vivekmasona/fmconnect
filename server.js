// server.js — BiharFM signaling + auto 4-listener rooms
// Node.js: npm i express ws
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("🎧 BiharFM auto-room signaling (4 listeners per room)"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Configuration
const MAX_PER_ROOM = 4;

// clientId -> { ws, role, customId, roomId }
const clients = new Map();
// roomId -> Set(clientId)
const rooms = new Map();

function genRoomId() {
  const n = Math.floor(1000 + Math.random() * 90000);
  return `fm${n}`;
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) {}
}

function findRoomWithSpace() {
  for (const [rid, set] of rooms.entries()) {
    if (set.size < MAX_PER_ROOM) return rid;
  }
  return null;
}

function addToRoom(clientId, roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(clientId);
  const c = clients.get(clientId);
  if (c) c.roomId = roomId;
}

function removeFromRoom(clientId) {
  const c = clients.get(clientId);
  if (!c || !c.roomId) return;
  const r = c.roomId;
  const set = rooms.get(r);
  if (set) {
    set.delete(clientId);
    if (set.size === 0) rooms.delete(r);
  }
  delete c.roomId;
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  clients.set(id, { ws, role: null, customId: id, roomId: null });
  console.log("→ connected:", id);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, role, customId, target, payload } = msg;
    const entry = clients.get(id);

    // --- Registration ---
    if (type === "register") {
      entry.role = role || "listener";
      if (customId) entry.customId = customId;

      // --- Listener logic ---
      if (entry.role === "listener") {
        let roomId = findRoomWithSpace();
        if (!roomId) roomId = genRoomId();
        addToRoom(id, roomId);
        safeSend(ws, { type: "room-assigned", roomId });
        console.log(`listener ${entry.customId} -> ${roomId} (${rooms.get(roomId).size}/${MAX_PER_ROOM})`);

        // Notify broadcaster(s)
        for (const [, c] of clients) {
          if (c.role === "broadcaster") {
            safeSend(c.ws, { type: "listener-joined", id, roomId });
          }
        }
      }

      // --- Broadcaster logic ---
      if (entry.role === "broadcaster") {
        console.log("▶ broadcaster registered");
        const list = Array.from(rooms.entries()).map(([r, s]) => ({ roomId: r, count: s.size }));
        safeSend(ws, { type: "rooms-info", rooms: list });
      }
      return;
    }

    // --- WebRTC signaling relay ---
    if (["offer", "answer", "candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
      return;
    }

    // --- Metadata broadcast ---
    if (type === "metadata" && clients.get(id)?.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) {
        if (c.role === "listener") safeSend(c.ws, { type: "metadata", ...payload });
      }
      return;
    }

    // --- Room message broadcast ---
    if (type === "room-message") {
      const c = clients.get(id);
      if (!c || !c.roomId) return;
      const set = rooms.get(c.roomId) || new Set();
      for (const cid of set) {
        if (cid === id) continue;
        const peer = clients.get(cid);
        if (peer) safeSend(peer.ws, { type: "room-message", from: id, payload });
      }
      return;
    }
  });

  // --- On disconnect ---
  ws.on("close", () => {
    console.log("← disconnected:", id);
    const entry = clients.get(id);
    const roomId = entry?.roomId;
    removeFromRoom(id);
    clients.delete(id);
    for (const [, c] of clients) {
      if (c.role === "broadcaster") safeSend(c.ws, { type: "peer-left", id, roomId });
    }
    if (roomId) console.log(`room ${roomId} now ${(rooms.get(roomId)?.size || 0)}/${MAX_PER_ROOM}`);
  });

  ws.on("error", () => {
    const entry = clients.get(id);
    const roomId = entry?.roomId;
    removeFromRoom(id);
    clients.delete(id);
    for (const [, c] of clients) {
      if (c.role === "broadcaster") safeSend(c.ws, { type: "peer-left", id, roomId });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎧 BiharFM signaling server running on port ${PORT} (max ${MAX_PER_ROOM}/room)`));
