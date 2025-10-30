// server.js — BiharFM tree-relay (Render compatible)
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
app.get("/", (_, res) => res.send("🎧 BiharFM tree-relay signaling active"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map();

function genLabel() {
  const n = Math.floor(1000 + Math.random() * 90000);
  return `fm${n}`;
}
function safeSend(ws, obj) {
  if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function findRoot() {
  for (const [id, c] of clients) if (c.role === "broadcaster") return id;
  return null;
}
function findParent() {
  const root = findRoot();
  if (!root) return null;
  const q = [root];
  while (q.length) {
    const id = q.shift();
    const c = clients.get(id);
    if (c && (c.children.size || 0) < 2) return id;
    for (const ch of c.children) q.push(ch);
  }
  return null;
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  const nodeLabel = genLabel();
  clients.set(id, { ws, role: null, parent: null, children: new Set(), nodeLabel });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const entry = clients.get(id);
    const { type, role, target, payload } = msg;

    if (type === "register") {
      entry.role = role;
      if (role === "broadcaster") {
        safeSend(ws, { type: "registered", id, nodeLabel });
      } else {
        const parentId = findParent();
        entry.parent = parentId;
        if (parentId) {
          const p = clients.get(parentId);
          p.children.add(id);
          safeSend(p.ws, { type: "listener-joined", id, nodeLabel });
        }
        safeSend(ws, { type: "room-assigned", parentId, nodeLabel });
      }
      return;
    }

    if (["offer", "answer", "candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
      return;
    }

    if (type === "metadata" && entry.role === "broadcaster") {
      for (const [cid, c] of clients)
        if (c.role === "listener") safeSend(c.ws, { type: "metadata", ...payload });
    }
  });

  ws.on("close", () => clients.delete(id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`✅ Signaling server listening on port ${PORT}`)
);
