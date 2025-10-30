// server.js — BiharFM cascade-relay with backup + heartbeat + auto-reassign
// npm i express ws
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.get("/", (_, res) => res.send("🎧 BiharFM cascade-relay signaling (auto-heal)"));
app.get("/admin/rooms", (_, res) => {
  const out = [];
  for (const [id, c] of clients.entries()) {
    out.push({ id, nodeLabel: c.nodeLabel, role: c.role, parentId: c.parentId, children: Array.from(c.children || []), lastSeen: c.lastSeen });
  }
  res.json(out);
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// CONFIG
const MAX_CHILDREN_PER_NODE = 2;
const ROOT_CHILD_LIMIT = 2;
const HEARTBEAT_TIMEOUT = 15_000; // if no heartbeat for 15s, consider dead

const clients = new Map(); // id -> { ws, role, parentId, children:Set, nodeLabel, lastSeen, backupParent }

function genLabel() {
  const n = Math.floor(1000 + Math.random() * 90000);
  return `fm${n}`;
}
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) {}
}

function findRootBroadcaster() {
  for (const [id, c] of clients.entries()) if (c.role === "broadcaster") return id;
  return null;
}
function bfsFindParent(limitForBroadcaster = ROOT_CHILD_LIMIT) {
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

// choose a backup parent: prefer parent's parent, else root broadcaster
function chooseBackupParent(parentId) {
  if (!parentId) return findRootBroadcaster();
  const parent = clients.get(parentId);
  if (!parent) return findRootBroadcaster();
  if (parent.parentId) return parent.parentId;
  return findRootBroadcaster();
}

function reassignChild(childId) {
  const child = clients.get(childId);
  if (!child) return;
  // find new parent
  const newParent = bfsFindParent();
  child.parentId = null;
  if (!newParent) {
    safeSend(child.ws, { type: "reassigned", newParent: null });
    console.log(`child ${child.nodeLabel} remains rootless (no broadcaster)`);
    return;
  }
  child.parentId = newParent;
  clients.get(newParent).children.add(childId);
  // tell new parent to create offer to this child
  safeSend(clients.get(newParent).ws, { type: "listener-joined", id: childId, childNodeLabel: child.nodeLabel });
  // tell child it has a parent now (child just waits for offer; but we inform)
  safeSend(child.ws, { type: "reassigned", newParent });
  // assign backup parent
  child.backupParent = chooseBackupParent(newParent);
  console.log(`reassigned child ${child.nodeLabel} -> parent ${clients.get(newParent).nodeLabel}`);
}

function heartbeatSweep() {
  const now = Date.now();
  for (const [id, c] of clients.entries()) {
    if ((now - (c.lastSeen || 0)) > HEARTBEAT_TIMEOUT) {
      console.log(`heartbeat timeout: ${id} ${c.nodeLabel}`);
      try { c.ws.terminate(); } catch (e) {}
      // close handler will handle cleanup
    }
  }
}

setInterval(heartbeatSweep, 5000);

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  const nodeLabel = genLabel();
  clients.set(id, { ws, role: null, parentId: null, children: new Set(), nodeLabel, lastSeen: Date.now(), backupParent: null });
  console.log("→ conn:", id, nodeLabel);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, role, customId, target, payload } = msg;
    const entry = clients.get(id);

    // heartbeat (keeps node alive)
    if (type === "heartbeat") {
      entry.lastSeen = Date.now();
      return;
    }

    // register as broadcaster/listener
    if (type === "register") {
      entry.role = role || "listener";
      if (customId) entry.customId = customId;

      if (entry.role === "broadcaster") {
        console.log("▶ broadcaster registered:", id, entry.nodeLabel);
        safeSend(ws, { type: "registered-as-broadcaster", id, nodeLabel: entry.nodeLabel });
        // try to attach any rootless nodes under broadcaster
        for (const [cid, c] of clients.entries()) {
          if (c.role === "listener" && !c.parentId) {
            reassignChild(cid);
          }
        }
      } else {
        // listener registration: assign parent via BFS
        const parentId = bfsFindParent();
        if (!parentId) {
          entry.parentId = null;
          entry.backupParent = null;
          safeSend(ws, { type: "room-assigned", nodeLabel: entry.nodeLabel, parentId: null });
          console.log(`listener ${entry.nodeLabel} assigned temporary (no root yet)`);
        } else {
          entry.parentId = parentId;
          clients.get(parentId).children.add(id);
          entry.backupParent = chooseBackupParent(parentId);
          safeSend(ws, { type: "room-assigned", nodeLabel: entry.nodeLabel, parentId });
          safeSend(clients.get(parentId).ws, { type: "listener-joined", id, childNodeLabel: entry.nodeLabel });
          console.log(`listener ${entry.nodeLabel} -> parent ${clients.get(parentId).nodeLabel} (backup ${entry.backupParent ? clients.get(entry.backupParent)?.nodeLabel : 'none'})`);
        }
      }
      return;
    }

    // signaling: offer/answer/candidate forwarded to target id
    if (["offer","answer","candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
      return;
    }

    // broadcaster commands/metadata forwarded to all clients
    if (type === "cmd" && entry.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) safeSend(c.ws, { type: "cmd", cmd: payload });
      return;
    }
    if (type === "metadata" && entry.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) safeSend(c.ws, { type: "metadata", ...payload });
      return;
    }

    // room-message forwarding to children
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
    // remove from parent children
    if (c.parentId) {
      const parent = clients.get(c.parentId);
      if (parent) parent.children.delete(id);
      if (parent) safeSend(parent.ws, { type: "child-left", id, nodeLabel: c.nodeLabel });
    }
    // attempt to reassign each child under best available parent
    for (const ch of Array.from(c.children)) {
      // detach
      const child = clients.get(ch);
      if (!child) continue;
      child.parentId = null;
      // find new parent
      const newParent = bfsFindParent();
      if (newParent) {
        child.parentId = newParent;
        clients.get(newParent).children.add(ch);
        safeSend(clients.get(newParent).ws, { type: "listener-joined", id: ch, childNodeLabel: child.nodeLabel });
        safeSend(child.ws, { type: "reassigned", newParent });
        child.backupParent = chooseBackupParent(newParent);
        console.log(`reassigned child ${child.nodeLabel} -> ${clients.get(newParent).nodeLabel}`);
      } else {
        safeSend(child.ws, { type: "reassigned", newParent: null });
        console.log(`child ${child.nodeLabel} remains rootless (waiting)`);
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
