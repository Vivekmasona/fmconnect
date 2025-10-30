// server.js — BiharFM with Mini-Host P2P Layer
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("🎧 BiharFM Mini-Host Signaling Live!"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Connected clients: id -> { ws, role, isMini }
const clients = new Map();

function safeSend(ws, data) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

setInterval(() => {
  for (const [, c] of clients)
    if (c.ws.readyState === c.ws.OPEN)
      safeSend(c.ws, { type: "ping" });
}, 25000);

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  clients.set(id, { ws, role: null, isMini: false });
  console.log("🔗 Client connected:", id);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, role, id: customId, target, payload } = msg;

    // Register listener or broadcaster
    if (type === "register") {
      clients.get(id).role = role;
      clients.get(id).customId = customId || id;

      if (role === "listener") {
        // Mini-host assignment (every 3rd listener)
        const num = parseInt((customId || "0").replace(/\D/g, "")) || Math.floor(Math.random() * 9999);
        const isMini = num % 3 === 0;
        clients.get(id).isMini = isMini;

        if (isMini) {
          console.log(`🎙️ Mini-host ready: ${customId}`);
          // Notify broadcaster to connect this mini-host
          for (const [, c] of clients)
            if (c.role === "broadcaster")
              safeSend(c.ws, { type: "listener-joined", id });
        } else {
          // Normal listener: connect to a random mini-host
          const minis = Array.from(clients.entries()).filter(([_, c]) => c.isMini);
          if (minis.length) {
            const [mid, mini] = minis[Math.floor(Math.random() * minis.length)];
            console.log(`👂 Listener ${customId} assigned to mini-host ${mini.customId}`);
            safeSend(mini.ws, { type: "mini-connect", id });
          } else {
            // No mini-host yet, wait for broadcaster fallback
            for (const [, c] of clients)
              if (c.role === "broadcaster")
                safeSend(c.ws, { type: "listener-joined", id });
          }
        }
      }

      if (role === "broadcaster") {
        console.log(`🧩 Broadcaster online`);
        const miniHosts = [...clients.values()].filter(c => c.isMini).length;
        safeSend(ws, { type: "mini-count", count: miniHosts });
      }
      return;
    }

    // Mini-host readiness
    if (type === "mini-ready") {
      const c = clients.get(id);
      if (c) c.isMini = true;
      console.log(`✅ Mini-host activated: ${c?.customId}`);
      return;
    }

    // Relay signaling messages
    if (["offer", "answer", "candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
      return;
    }

    // Metadata relay to all listeners
    if (type === "metadata") {
      for (const [, c] of clients)
        if (c.role === "listener")
          safeSend(c.ws, { type: "metadata", ...payload });
    }
  });

  ws.on("close", () => {
    const c = clients.get(id);
    if (!c) return;
    console.log(`❌ Disconnected: ${c.customId || id}`);
    clients.delete(id);
  });
});

server.keepAliveTimeout = 70000;
server.headersTimeout = 75000;
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`✅ Mini-Host BiharFM Signaling running on ${PORT}`)
);
