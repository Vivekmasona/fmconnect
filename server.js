// server.js — BiharFM tree-relay signaling (Render OK version)
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("🎧 BiharFM tree-relay signaling is live!"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map();

function genLabel() {
  return "fm" + Math.floor(1000 + Math.random() * 90000);
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {}
  }
}

function findRoot() {
  for (const [id, c] of clients.entries())
    if (c.role === "broadcaster") return id;
  return null;
}

function findParent() {
  const root = findRoot();
  if (!root) return null;
  const q = [root];
  while (q.length) {
    const id = q.shift();
    const c = clients.get(id);
    if (!c) continue;
    if ((c.children?.size || 0) < 2) return id;
    for (const ch of c.children || []) q.push(ch);
  }
  return null;
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  const nodeLabel = genLabel();
  clients.set(id, { ws, role: null, parentId: null, children: new Set(), nodeLabel });
  console.log("→ connected:", id, nodeLabel);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const entry = clients.get(id);
    if (!entry) return;
    const { type, role, target, payload } = msg;

    if (type === "register") {
      entry.role = role;
      if (role === "broadcaster") {
        console.log("🎙 broadcaster registered:", nodeLabel);
        safeSend(ws, { type: "registered-as-broadcaster", nodeLabel });
      } else {
        const parentId = findParent();
        entry.parentId = parentId;
        if (parentId) {
          const parent = clients.get(parentId);
          parent.children.add(id);
          safeSend(ws, { type: "room-assigned", parentId, nodeLabel });
          safeSend(parent.ws, { type: "listener-joined", id, nodeLabel });
        } else {
          safeSend(ws, { type: "room-assigned", parentId: null, nodeLabel });
        }
      }
      return;
    }

    // Forward offer/answer/candidate
    if (["offer", "answer", "candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
      return;
    }

    // Metadata broadcast
    if (type === "metadata" && entry.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) {
        if (c.role === "listener") safeSend(c.ws, { type: "metadata", ...payload });
      }
      return;
    }
  });

  ws.on("close", () => {
    const c = clients.get(id);
    if (!c) return;
    console.log("❌ closed:", id);
    if (c.parentId) {
      const p = clients.get(c.parentId);
      if (p) p.children.delete(id);
    }
    clients.delete(id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("✅ Server running on port", PORT));
