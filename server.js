// server.js — BiharFM scalable signaling

import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";

const app = express();
app.get("/", (_, res) => res.send("🎧 BiharFM Scalable Signaling Server running..."));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let mainHost = null;
let miniHosts = {}; // { miniID: { socket, listeners: [] } }

function randomMiniID() {
  return "vivek" + Math.floor(1000 + Math.random() * 9000);
}

wss.on("connection", (ws) => {
  ws.role = null;

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // --- Main host connects ---
      if (data.type === "main-host") {
        mainHost = ws;
        ws.role = "main";
        console.log("Main host connected");
        sendMiniHostList();
      }

      // --- Mini host register ---
      else if (data.type === "register-mini") {
        ws.role = "mini";
        ws.miniID = randomMiniID();
        miniHosts[ws.miniID] = { socket: ws, listeners: [] };
        console.log("Mini host registered:", ws.miniID);
        sendMiniHostList();
        ws.send(JSON.stringify({ type: "mini-registered", id: ws.miniID }));
      }

      // --- Listener join ---
      else if (data.type === "listener-join") {
        const availableMini = Object.keys(miniHosts).find(
          (id) => miniHosts[id].listeners.length < 2
        );
        if (availableMini) {
          miniHosts[availableMini].listeners.push(ws);
          ws.role = "listener";
          ws.miniID = availableMini;
          console.log("Listener joined mini host:", availableMini);
          miniHosts[availableMini].socket.send(
            JSON.stringify({ type: "new-listener", id: availableMini })
          );
          ws.send(JSON.stringify({ type: "assigned-mini", id: availableMini }));
        } else {
          // Create new mini host slot
          ws.send(JSON.stringify({ type: "wait-mini" }));
        }
      }

      // --- Forward WebRTC / sync messages ---
      else if (data.type === "signal") {
        const target = [...wss.clients].find((c) => c.id === data.target);
        if (target && target.readyState === 1)
          target.send(JSON.stringify(data));
      }

      // --- Sync broadcast (from main host to all mini hosts) ---
      else if (data.type === "sync-song") {
        for (const id in miniHosts)
          miniHosts[id].socket.send(JSON.stringify(data));
      }
    } catch (e) {
      console.error("Error:", e);
    }
  });

  ws.on("close", () => {
    if (ws.role === "mini") {
      delete miniHosts[ws.miniID];
      sendMiniHostList();
    }
    if (ws.role === "main") mainHost = null;
  });
});

function sendMiniHostList() {
  if (mainHost && mainHost.readyState === 1) {
    const list = Object.keys(miniHosts);
    mainHost.send(JSON.stringify({ type: "mini-list", list }));
  }
}

server.listen(3000, () => console.log("✅ Server running on :3000"));
