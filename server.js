// server.js — BiharFM signaling + auto 2-listener rooms
// Node.js: npm i express ws
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("🎧 BiharFM auto-room signaling"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
function findRoomWithOne() {
  for (const [rid, set] of rooms.entries()) {
    if (set.size === 1) return rid;
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

    if (type === "register") {
      entry.role = role || "listener";
      if (customId) entry.customId = customId;

      if (entry.role === "listener") {
        // assign to room with 1 member or create new
        let roomId = findRoomWithOne();
        if (!roomId) roomId = genRoomId();
        addToRoom(id, roomId);
        safeSend(ws, { type: "room-assigned", roomId });
        console.log(`listener ${entry.customId} -> ${roomId} (${rooms.get(roomId).size}/2)`);

        // notify broadcaster(s) about join so broadcaster can make peer/offer
        for (const [, c] of clients) {
          if (c.role === "broadcaster") safeSend(c.ws, { type: "listener-joined", id, roomId });
        }
      }

      if (entry.role === "broadcaster") {
        console.log("▶ broadcaster registered");
        // optionally send current rooms state
        const list = Array.from(rooms.entries()).map(([r,s])=>({ roomId: r, count: s.size }));
        safeSend(ws, { type: "rooms-info", rooms: list });
      }
      return;
    }

    // signaling relay (offer/answer/candidate)
    if (["offer","answer","candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
      return;
    }

    // metadata from broadcaster -> forward to listeners
    if (type === "metadata" && clients.get(id)?.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) {
        if (c.role === "listener") safeSend(c.ws, { type: "metadata", ...payload });
      }
      return;
    }

    // optional: room-message (forward to peers in same room)
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

  ws.on("close", () => {
    console.log("← disconnected:", id);
    const entry = clients.get(id);
    const roomId = entry?.roomId;
    removeFromRoom(id);
    clients.delete(id);
    // notify broadcasters about peer-left
    for (const [, c] of clients) {
      if (c.role === "broadcaster") safeSend(c.ws, { type: "peer-left", id, roomId });
    }
    if (roomId) console.log(`room ${roomId} now ${(rooms.get(roomId)?.size || 0)}`);
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
server.listen(PORT, () => console.log(`Signaling server listening on ${PORT}`));
