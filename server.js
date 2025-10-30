// server.js — BiharFM cascade-relay signaling (Node.js)
// npm i express ws
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("🎧 BiharFM cascade-relay signaling"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// CONFIG
const MAX_CHILDREN_PER_NODE = 2;   // each node forwards to at most 2 children
const ROOT_CHILD_LIMIT = 2;        // broadcaster direct children (small)

// clients: id -> { ws, role, parentId, children:Set, nodeLabel }
const clients = new Map();

function genLabel() {
  const n = Math.floor(1000 + Math.random() * 90000);
  return `fm${n}`;
}
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) {}
}

// find broadcaster root id (first broadcaster)
function findRootBroadcaster() {
  for (const [id, c] of clients.entries()) if (c.role === "broadcaster") return id;
  return null;
}

// BFS to find first node with children < limit
function findParentNodeForNew() {
  const rootId = findRootBroadcaster();
  if (!rootId) return null;
  const q = [rootId];
  while (q.length) {
    const id = q.shift();
    const c = clients.get(id);
    if (!c) continue;
    const limit = (c.role === "broadcaster") ? ROOT_CHILD_LIMIT : MAX_CHILDREN_PER_NODE;
    if ((c.children?.size || 0) < limit) return id;
    for (const ch of c.children) q.push(ch);
  }
  return null;
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  const nodeLabel = genLabel();
  clients.set(id, { ws, role: null, parentId: null, children: new Set(), nodeLabel });
  console.log("→ conn:", id, nodeLabel);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, role, customId, target, payload } = msg;
    const entry = clients.get(id);

    // register
    if (type === "register") {
      entry.role = role || "listener";
      if (customId) entry.customId = customId;

      if (entry.role === "broadcaster") {
        console.log("▶ broadcaster registered:", id, entry.nodeLabel);
        safeSend(ws, { type: "registered-as-broadcaster", id, nodeLabel: entry.nodeLabel });
        // notify existing listeners: try to reassign any rootless children to this root
        for (const [cid, c] of clients.entries()) {
          if (c.role === "listener" && !c.parentId) {
            // attempt to place them under root if room
            const parent = findParentNodeForNew();
            if (parent) {
              c.parentId = parent;
              clients.get(parent).children.add(cid);
              safeSend(c.ws, { type: "room-assigned", nodeLabel: c.nodeLabel, parentId: parent });
              safeSend(clients.get(parent).ws, { type: "listener-joined", id: cid, childNodeLabel: c.nodeLabel });
              console.log(`reassigned existing ${cid} -> parent ${parent}`);
            }
          }
        }
      } else {
        // listener: assign parent via BFS
        const parentId = findParentNodeForNew();
        if (!parentId) {
          entry.parentId = null;
          safeSend(ws, { type: "room-assigned", nodeLabel: entry.nodeLabel, parentId: null });
          console.log(`listener ${entry.nodeLabel} assigned temporary (no root yet)`);
        } else {
          entry.parentId = parentId;
          const parent = clients.get(parentId);
          parent.children.add(id);
          safeSend(ws, { type: "room-assigned", nodeLabel: entry.nodeLabel, parentId });
          // notify parent to create an offer for this new child
          safeSend(parent.ws, { type: "listener-joined", id, childNodeLabel: entry.nodeLabel });
          console.log(`listener ${entry.nodeLabel} -> parent ${parent.nodeLabel}`);
        }
      }
      return;
    }

    // signaling messages forwarded by target id
    if (["offer","answer","candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
      return;
    }

    // broadcaster commands/metadata: forward to everyone as control messages
    if (type === "cmd" && clients.get(id)?.role === "broadcaster") {
      // broadcast command to all clients (listeners + relays)
      for (const [cid, c] of clients.entries()) {
        safeSend(c.ws, { type: "cmd", cmd: payload });
      }
      return;
    }

    // metadata from broadcaster -> forward to everyone (so UI updates)
    if (type === "metadata" && clients.get(id)?.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) {
        safeSend(c.ws, { type: "metadata", ...payload });
      }
      return;
    }

    // optional: room-message forwarded to children
    if (type === "room-message") {
      const e = clients.get(id);
      if (!e) return;
      for (const ch of e.children) {
        const c = clients.get(ch);
        if (c) safeSend(c.ws, { type: "room-message", from: id, payload });
      }
      return;
    }
  });

  ws.on("close", () => {
    const c = clients.get(id);
    if (!c) return;
    console.log("← close:", id, c.nodeLabel);
    // detach from parent
    if (c.parentId) {
      const parent = clients.get(c.parentId);
      if (parent) parent.children.delete(id);
      if (parent) safeSend(parent.ws, { type: "child-left", id, nodeLabel: c.nodeLabel });
    }
    // try to reassign children: set parentId null, then try to re-place each child
    for (const ch of Array.from(c.children)) {
      const child = clients.get(ch);
      if (!child) continue;
      child.parentId = null;
      // find a new parent
      const newParent = findParentNodeForNew();
      if (newParent) {
        child.parentId = newParent;
        clients.get(newParent).children.add(ch);
        safeSend(child.ws, { type: "reassigned", newParent });
        safeSend(clients.get(newParent).ws, { type: "listener-joined", id: ch, childNodeLabel: child.nodeLabel });
        console.log(`reassigned child ${child.nodeLabel} -> newParent ${clients.get(newParent).nodeLabel}`);
      } else {
        safeSend(child.ws, { type: "reassigned", newParent: null });
        console.log(`child ${child.nodeLabel} left rootless (waiting)`);
      }
    }
    clients.delete(id);
  });

  ws.on("error", (err) => {
    console.warn("ws error for", id, err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Signaling server listening on", PORT));
