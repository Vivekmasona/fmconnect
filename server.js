// server.js — BiharFM tree-relay signaling (Node.js)
// npm i express ws
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("🎧 BiharFM tree-relay signaling"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// clientId -> { ws, role, customId, parentId, children:Set, nodeLabel }
const clients = new Map();

// helper: generate node label like fm12345
function genLabel() {
  const n = Math.floor(1000 + Math.random() * 90000);
  return `fm${n}`;
}
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch(e) {}
}

// Find root broadcaster id
function findRootBroadcaster() {
  for (const [id, c] of clients.entries()) if (c.role === "broadcaster") return id;
  return null;
}

// BFS to find first node with children.size < 2
function findParentNode() {
  const rootId = findRootBroadcaster();
  if (!rootId) return null;
  const q = [rootId];
  while (q.length) {
    const id = q.shift();
    const c = clients.get(id);
    if (!c) continue;
    if ((c.children?.size || 0) < 2) return id;
    // push children
    for (const ch of c.children || []) q.push(ch);
  }
  return null;
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  const nodeLabel = genLabel();
  clients.set(id, { ws, role: null, customId: id, parentId: null, children: new Set(), nodeLabel });
  console.log("→ conn:", id, nodeLabel);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, role, customId, target, payload } = msg;
    const entry = clients.get(id);

    // register client
    if (type === "register") {
      entry.role = role || "listener";
      if (customId) entry.customId = customId;

      if (entry.role === "broadcaster") {
        // mark as root; keep children set as-is
        console.log("▶ broadcaster registered:", id);
        // reply with root info
        safeSend(ws, { type: "registered-as-broadcaster", id, nodeLabel: entry.nodeLabel });
        // optionally send rooms state
      } else {
        // listener registration: place under a parent node found by BFS
        const parentId = findParentNode();
        if (!parentId) {
          // no broadcaster yet — still assign rootless node (will be found when broadcaster registers)
          entry.parentId = null;
          safeSend(ws, { type: "room-assigned", nodeLabel: entry.nodeLabel, parentId: null });
          console.log(`listener ${entry.customId} assigned temporary node ${entry.nodeLabel} (no root yet)`);
        } else {
          entry.parentId = parentId;
          // add to parent's children
          const parent = clients.get(parentId);
          if (parent) parent.children.add(id);
          safeSend(ws, { type: "room-assigned", nodeLabel: entry.nodeLabel, parentId });
          console.log(`listener ${entry.customId} -> parent ${parentId} (${parent.nodeLabel}) node ${entry.nodeLabel}`);

          // notify parent so it creates an offer to this child
          const parentWs = parent.ws;
          safeSend(parentWs, { type: "listener-joined", id, childNodeLabel: entry.nodeLabel });
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

    // metadata from broadcaster -> forward to everyone (or we can forward subtree)
    if (type === "metadata" && entry.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) {
        if (c.role === "listener") safeSend(c.ws, { type: "metadata", ...payload });
      }
      return;
    }

    // optional: if a relay wants to broadcast its own metadata to its descendants
    if (type === "metadata" && entry.role === "listener") {
      // forward to children of this node
      for (const ch of entry.children) {
        const c = clients.get(ch);
        if (c) safeSend(c.ws, { type: "metadata", ...payload });
      }
      return;
    }

    // room-message forwarded within node's children (optional)
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
    // remove from parent's children
    if (c.parentId) {
      const parent = clients.get(c.parentId);
      if (parent) parent.children.delete(id);
      // notify parent that child left
      if (parent) safeSend(parent.ws, { type: "child-left", id, nodeLabel: c.nodeLabel });
    }
    // for each child, detach them: reassign children to best parent (simple: set their parent to null, then on next register or join they'll be reassigned)
    for (const ch of c.children) {
      const child = clients.get(ch);
      if (child) {
        child.parentId = null;
        // try to find new parent for child (attempt immediate reassignment)
        const newParent = findParentNode();
        if (newParent) {
          child.parentId = newParent;
          const np = clients.get(newParent);
          if (np) np.children.add(ch);
          safeSend(child.ws, { type: "reassigned", newParent });
          safeSend(np.ws, { type: "listener-joined", id: ch, childNodeLabel: child.nodeLabel });
        } else {
          safeSend(child.ws, { type: "reassigned", newParent: null });
        }
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
