// server.js
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();

app.get("/", (req, res) => {
  res.send("🎧 FM WebRTC Signaling Server is Live and Ready!");
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map(); // id -> { ws, role }

function safeSend(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

// keep Render connections alive
setInterval(() => {
  for (const [, c] of clients)
    if (c.ws.readyState === c.ws.OPEN) safeSend(c.ws, { type: "ping" });
}, 25000);

wss.on("connection", (ws, req) => {
  const id = crypto.randomUUID();
  clients.set(id, { ws });
  console.log("🔗 Connected:", id);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, role, target, payload } = msg;

    // Register client
    if (type === "register") {
      clients.get(id).role = role;
      console.log(`🧩 ${id} registered as ${role}`);
      if (role === "listener") {
        for (const [, c] of clients)
          if (c.role === "broadcaster")
            safeSend(c.ws, { type: "listener-joined", id });
      }
    }

    // Relay messages
    if (["offer", "answer", "candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
    }
  });

  ws.on("close", () => {
    clients.delete(id);
    console.log("❌ Disconnected:", id);
    for (const [, c] of clients)
      if (c.role === "broadcaster") safeSend(c.ws, { type: "peer-left", id });
  });

  ws.on("error", (err) => console.error("WebSocket error:", err.message));
});

server.keepAliveTimeout = 70000;
server.headersTimeout = 75000;

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ FM Server running on port ${PORT}`));
