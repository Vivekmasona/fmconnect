// server.js — Bihar FM Signaling + Pairing (mini-host every N listeners)
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (req, res) => res.send("🎧 Bihar FM Signaling (paired relays)"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// config: capacity = number of listeners per mini-host (2 or 3)
const RELAY_CAPACITY = parseInt(process.env.CAPACITY || "2", 10);

// data stores
const clients = new Map();      // id -> { ws, role, pairId }
const waitingQueue = [];        // list of listener ids waiting to be grouped
const pairs = new Map();        // pairId -> { members: [ids], miniHostId }

// safe json send
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { console.warn("send fail", e.message); }
}

// ping to keep alive
setInterval(() => {
  for (const [, c] of clients) safeSend(c.ws, { type: "ping" });
}, 25000);

// try form a pair when enough listeners waiting
function tryFormPair() {
  while (waitingQueue.length >= RELAY_CAPACITY) {
    const group = waitingQueue.splice(0, RELAY_CAPACITY);
    const pairId = "vivek" + Math.floor(Math.random() * 900000 + 1000);
    // choose miniHost randomly from group
    const miniHostIndex = Math.floor(Math.random() * group.length);
    const miniHostId = group[miniHostIndex];

    pairs.set(pairId, { members: group.slice(), miniHostId });

    // set pairId for members
    group.forEach(id => {
      const c = clients.get(id);
      if (c) c.pairId = pairId;
    });

    // notify members
    group.forEach(id => {
      const c = clients.get(id);
      if (!c) return;
      const role = id === miniHostId ? "mini-host" : "listener";
      safeSend(c.ws, {
        type: "pair-created",
        pairId,
        members: group,
        miniHostId,
        role
      });
    });

    console.log(`🔗 Pair created ${pairId} members:`, group, "miniHost:", miniHostId);
  }
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  clients.set(id, { ws, role: null, pairId: null });
  console.log("➕ connected", id);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const { type, role, target, payload, pairId } = msg;

    // register
    if (type === "register") {
      clients.get(id).role = role;
      console.log(`🧩 ${id} registered as ${role}`);

      // for listeners, push to queue and try pairing
      if (role === "listener") {
        if (!waitingQueue.includes(id)) {
          waitingQueue.push(id);
          tryFormPair();
        }
        // also notify any broadcaster(s) about new listener (optional)
        for (const [, c] of clients) if (c.role === "broadcaster")
          safeSend(c.ws, { type: "listener-joined", id });
      }
      return;
    }

    // simple routing of offer/answer/candidate by target id
    if (["offer", "answer", "candidate"].includes(type) && target) {
      const tgt = clients.get(target);
      if (tgt) {
        safeSend(tgt.ws, { type, from: id, payload, pairId: msg.pairId || null });
      }
      return;
    }

    // relay metadata to all listeners & mini-hosts
    if (type === "metadata") {
      for (const [, c] of clients) {
        if (c.role === "listener" || c.role === "mini-host") {
          safeSend(c.ws, { type: "metadata", ...payload });
        }
      }
      return;
    }

    // master sync: broadcast to everyone (mini-hosts and listeners)
    if (type === "sync") {
      for (const [, c] of clients) {
        // don't echo back to sender
        if (c.ws === ws) continue;
        safeSend(c.ws, { type: "sync", payload });
      }
      return;
    }

    // pair-level messages (optional: forwarded to all members of a pair)
    if (type === "pair-msg" && pairId) {
      const p = pairs.get(pairId);
      if (p) {
        p.members.forEach(mid => {
          const m = clients.get(mid);
          if (m) safeSend(m.ws, { type: "pair-msg", from: id, payload });
        });
      }
      return;
    }
  });

  ws.on("close", () => {
    const info = clients.get(id) || {};
    const role = info.role;
    const pairId = info.pairId;
    clients.delete(id);
    console.log("❌ disconnected", id, role);

    // remove from waiting queue if present
    const qidx = waitingQueue.indexOf(id);
    if (qidx !== -1) waitingQueue.splice(qidx, 1);

    // if part of a pair, notify remaining members and cleanup pair
    if (pairId && pairs.has(pairId)) {
      const p = pairs.get(pairId);
      // notify others in pair that this member left
      p.members.forEach(mid => {
        if (mid === id) return;
        const c = clients.get(mid);
        if (c) safeSend(c.ws, { type: "peer-left", id });
      });
      pairs.delete(pairId);
    }

    // notify broadcaster(s)
    if (role === "listener") {
      for (const [, c] of clients) if (c.role === "broadcaster")
        safeSend(c.ws, { type: "peer-left", id });
    }
  });

  ws.on("error", (err) => console.error("WS err", err?.message));
});

server.listen(process.env.PORT || 3000, () => {
  console.log("✅ Bihar FM Signaling running on port", process.env.PORT || 3000);
});
