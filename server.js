// server.js — Cascade relay with auto-heal + forwarding hints
// npm i express ws
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* CONFIG */
const MAX_CHILDREN_PER_NODE = 2;   // each node's max children
const ROOT_CHILD_LIMIT = 2;        // broadcaster direct children
const HEARTBEAT_TIMEOUT = 15000;   // ms
const REBALANCE_INTERVAL = 8000;   // ms

const clients = new Map(); // id -> { ws, role, parentId, children:Set, nodeLabel, lastSeen }

/* HTTP debug endpoint */
app.get("/", (_, res) => res.send("🎧 BiharFM cascade-relay (auto-heal)"));
app.get("/admin/rooms", (_, res) => {
  const out = [];
  for (const [id, c] of clients.entries()) {
    out.push({
      id,
      nodeLabel: c.nodeLabel,
      role: c.role,
      parentId: c.parentId,
      children: Array.from(c.children || []),
      lastSeen: c.lastSeen
    });
  }
  res.json(out);
});

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
// BFS find parent with capacity; excludeSet optional
function findParentNode(exclude = new Set()) {
  const rootId = findRootBroadcaster();
  if (!rootId) return null;
  const q = [rootId];
  while (q.length) {
    const id = q.shift();
    if (exclude.has(id)) continue;
    const c = clients.get(id);
    if (!c) continue;
    const limit = (c.role === "broadcaster") ? ROOT_CHILD_LIMIT : MAX_CHILDREN_PER_NODE;
    if ((c.children?.size || 0) < limit) return id;
    for (const ch of c.children) if (!exclude.has(ch)) q.push(ch);
  }
  return null;
}

function chooseBackupParent(parentId) {
  if (!parentId) return findRootBroadcaster();
  const parent = clients.get(parentId);
  if (!parent) return findRootBroadcaster();
  if (parent.parentId) return parent.parentId;
  return findRootBroadcaster();
}

function assignParentFor(childId) {
  const child = clients.get(childId);
  if (!child) return;
  const parentId = findParentNode(new Set());
  if (!parentId) {
    child.parentId = null;
    safeSend(child.ws, { type: "room-assigned", nodeLabel: child.nodeLabel, parentId: null });
    console.log(`listener ${child.nodeLabel} assigned temporary (no root)`);
    return;
  }
  child.parentId = parentId;
  clients.get(parentId).children.add(childId);
  child.backupParent = chooseBackupParent(parentId);
  safeSend(child.ws, { type: "room-assigned", nodeLabel: child.nodeLabel, parentId });
  safeSend(clients.get(parentId).ws, { type: "listener-joined", id: childId, childNodeLabel: child.nodeLabel });
  console.log(`listener ${child.nodeLabel} -> parent ${clients.get(parentId).nodeLabel} (backup ${child.backupParent ? clients.get(child.backupParent)?.nodeLabel : 'none'})`);
}

function heartbeatSweep() {
  const now = Date.now();
  for (const [id, c] of clients.entries()) {
    if (!c.lastSeen) c.lastSeen = now;
    if ((now - c.lastSeen) > HEARTBEAT_TIMEOUT) {
      console.log(`heartbeat timeout for ${id} ${c.nodeLabel} - terminating`);
      try { c.ws.terminate(); } catch (e) {}
    }
  }
}

function rebalance() {
  // gather candidate parents sorted by load asc
  const cand = [];
  for (const [id, c] of clients.entries()) {
    if (!c.role) continue;
    const limit = (c.role === "broadcaster") ? ROOT_CHILD_LIMIT : MAX_CHILDREN_PER_NODE;
    cand.push({ id, load: c.children.size, limit });
  }
  cand.sort((a,b) => a.load - b.load);

  for (const [id, c] of clients.entries()) {
    const limit = (c.role === "broadcaster") ? ROOT_CHILD_LIMIT : MAX_CHILDREN_PER_NODE;
    if ((c.children.size || 0) <= limit) continue;
    const overflow = Array.from(c.children).slice(limit);
    for (const childId of overflow) {
      const dest = cand.find(x => x.id !== id && x.load < x.limit);
      if (!dest) break;
      c.children.delete(childId);
      const child = clients.get(childId);
      if (!child) continue;
      child.parentId = dest.id;
      clients.get(dest.id).children.add(childId);
      dest.load++;
      safeSend(clients.get(dest.id).ws, { type: "listener-joined", id: childId, childNodeLabel: child.nodeLabel });
      safeSend(child.ws, { type: "reassigned", newParent: dest.id });
      console.log(`rebalanced child ${child.nodeLabel} -> ${clients.get(dest.id).nodeLabel}`);
    }
  }
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  const nodeLabel = genLabel();
  clients.set(id, { ws, role: null, parentId: null, children: new Set(), nodeLabel, lastSeen: Date.now() });
  console.log("→ conn:", id, nodeLabel);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, role, customId, target, payload } = msg;
    const entry = clients.get(id);
    if (!entry) return;

    if (type === "heartbeat") { entry.lastSeen = Date.now(); return; }

    if (type === "register") {
      entry.role = role || "listener";
      if (customId) entry.customId = customId;
      if (entry.role === "broadcaster") {
        console.log("▶ broadcaster registered:", id, entry.nodeLabel);
        safeSend(ws, { type: "registered-as-broadcaster", id, nodeLabel: entry.nodeLabel });
        for (const [cid, c] of clients.entries()) if (c.role === "listener" && !c.parentId) assignParentFor(cid);
      } else {
        assignParentFor(id);
      }
      return;
    }

    if (["offer","answer","candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
      return;
    }

    if (type === "cmd" && entry.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) safeSend(c.ws, { type: "cmd", cmd: payload });
      return;
    }
    if (type === "metadata" && entry.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) safeSend(c.ws, { type: "metadata", ...payload });
      return;
    }

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
    if (c.parentId) {
      const parent = clients.get(c.parentId);
      if (parent) {
        parent.children.delete(id);
        safeSend(parent.ws, { type: "child-left", id, nodeLabel: c.nodeLabel });
      }
    }
    const children = Array.from(c.children);
    for (const ch of children) {
      const child = clients.get(ch);
      if (!child) continue;
      child.parentId = null;
      const exclude = new Set([id,ch]);
      const newParent = findParentNode(exclude);
      if (newParent) {
        child.parentId = newParent;
        clients.get(newParent).children.add(ch);
        safeSend(clients.get(newParent).ws, { type: "listener-joined", id: ch, childNodeLabel: child.nodeLabel });
        safeSend(child.ws, { type: "reassigned", newParent });
        child.backupParent = chooseBackupParent(newParent);
        console.log(`reassigned child ${child.nodeLabel} -> ${clients.get(newParent).nodeLabel}`);
      } else {
        safeSend(child.ws, { type: "reassigned", newParent: null });
        console.log(`child ${child.nodeLabel} remains rootless`);
      }
    }
    clients.delete(id);
  });

  ws.on("error", (err) => console.warn("ws error for", id, err));
});

setInterval(heartbeatSweep, 5000);
setInterval(rebalance, REBALANCE_INTERVAL);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Signaling server listening on", PORT));
