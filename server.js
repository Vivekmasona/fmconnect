// server.js — BiharFM signaling + auto binary-tree mini-host assignment
// Node.js: npm i express ws
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("🎧 BiharFM tree signaling"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// clients: id -> { ws, role, customId, parentId, children: Set }
const clients = new Map();

// queue of clientIds that can accept children (maxChildren = 2)
const availableParents = []; // FIFO queue

function mkClientEntry(ws) {
  return { ws, role: null, customId: null, parentId: null, children: new Set() };
}
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) {}
}
function enqueueParent(id) {
  if (!id) return;
  if (!availableParents.includes(id)) availableParents.push(id);
}
function dequeueParent() {
  return availableParents.shift();
}
function hasCapacity(id) {
  const c = clients.get(id);
  if (!c) return false;
  return c.children.size < 2;
}
function tryRequeue(id) {
  if (!id) return;
  if (hasCapacity(id)) enqueueParent(id);
}
function removeFromQueue(id) {
  const i = availableParents.indexOf(id);
  if (i >= 0) availableParents.splice(i, 1);
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  clients.set(id, mkClientEntry(ws));
  clients.get(id).customId = id;
  console.log("→ connected:", id);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, role, customId, target, payload } = msg;
    const entry = clients.get(id);

    if (type === "register") {
      entry.role = role || "listener";
      if (customId) entry.customId = customId;

      if (entry.role === "broadcaster") {
        console.log("▶ broadcaster registered:", id);
        // broadcaster becomes root parent
        enqueueParent(id);
        // inform broadcaster of current available parents (optional)
        safeSend(ws, { type: "rooms-info", availableParentsCount: availableParents.length });
        return;
      }

      // listener registration -> assign a parent from availableParents
      if (entry.role === "listener") {
        // find parent with capacity
        // prefer the earliest enqueued parent with capacity
        let parentId = null;
        while (availableParents.length) {
          const cand = availableParents[0]; // peek
          if (hasCapacity(cand)) { parentId = cand; break; }
          // else remove exhausted candidate
          dequeueParent();
        }
        if (!parentId) {
          // if none available, fallback: choose broadcaster if any
          parentId = Array.from(clients.entries()).find(([k,v])=>v.role==="broadcaster")?.[0] || null;
          if (!parentId) {
            // no broadcaster yet: assign to self (will enqueue)
            parentId = id;
          }
        }

        // assign parent-child linking
        entry.parentId = parentId;
        const parentEntry = clients.get(parentId);
        if (parentEntry) {
          parentEntry.children.add(id);
        }

        // enqueue the new listener as potential parent (it can accept children)
        enqueueParent(id);

        // if parent now full (2 children), remove it from queue
        if (!hasCapacity(parentId)) removeFromQueue(parentId);

        // notify parent to create offer to this child
        if (parentEntry && parentEntry.ws && parentEntry.ws.readyState === parentEntry.ws.OPEN) {
          safeSend(parentEntry.ws, { type: "child-joined", childId: id });
        }

        // notify the child of its parent assignment
        safeSend(ws, { type: "parent-assigned", parentId });

        console.log(`listener ${entry.customId} assigned parent ${parentId}`);
        return;
      }
    }

    // signaling passthrough (offer/answer/candidate) to specific target
    if (["offer","answer","candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
      return;
    }

    // metadata from broadcaster -> forward to all listeners (for UI)
    if (type === "metadata" && clients.get(id)?.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) {
        if (c.role === "listener") safeSend(c.ws, { type: "metadata", ...payload });
      }
      return;
    }

    // room-message / misc forwarding within subtree (optional)
    if (type === "room-message") {
      // forward to children only (optional)
      const c = clients.get(id);
      if (!c) return;
      for (const childId of c.children) {
        const ch = clients.get(childId);
        if (ch) safeSend(ch.ws, { type: "room-message", from: id, payload });
      }
      return;
    }
  });

  ws.on("close", () => {
    console.log("← disconnected:", id);
    const entry = clients.get(id);
    if (!entry) return;

    // remove from parent's children set
    const parentId = entry.parentId;
    if (parentId && clients.has(parentId)) {
      clients.get(parentId).children.delete(id);
      // parent may regain capacity -> requeue it
      tryRequeue(parentId);
      // notify parent that child left
      safeSend(clients.get(parentId).ws, { type: "child-left", childId: id });
    }

    // for each child of this node, we should reassign them to other parents
    // naive approach: reassign each child by treating them as new join (enqueue them and pick new parent)
    // but to keep simple, notify children to reconnect (client will re-register)
    for (const childId of entry.children) {
      const ch = clients.get(childId);
      if (ch) {
        safeSend(ch.ws, { type: "parent-lost" });
      }
    }

    // remove from availableParents if present
    removeFromQueue(id);

    clients.delete(id);
  });

  ws.on("error", () => {
    // similar cleanup as close
    const entry = clients.get(id);
    if (!entry) return;
    const parentId = entry.parentId;
    if (parentId && clients.has(parentId)) {
      clients.get(parentId).children.delete(id);
      tryRequeue(parentId);
      safeSend(clients.get(parentId).ws, { type: "child-left", childId: id });
    }
    for (const childId of entry.children) {
      const ch = clients.get(childId);
      if (ch) safeSend(ch.ws, { type: "parent-lost" });
    }
    removeFromQueue(id);
    clients.delete(id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server listening on ${PORT}`));
