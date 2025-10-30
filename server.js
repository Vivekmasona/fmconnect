// server.js — BiharFM signaling with auto re-parent + rebalance
// npm i express ws
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// CONFIG — tune these for your deployment
const MAX_CHILDREN_PER_NODE = 2;   // desired children per relay node
const ROOT_CHILD_LIMIT = 2;        // how many direct children broadcaster should have
const HEARTBEAT_TIMEOUT = 15_000;  // ms — if no heartbeat from client, consider dead
const REBALANCE_INTERVAL = 8_000;  // ms — run rebalance every n ms

// clients: id -> { ws, role, parentId, children:Set, nodeLabel, lastSeen }
const clients = new Map();

app.get("/", (_, res) => res.send("🎧 BiharFM signaling (auto-reparent)"));
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
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}
function findRootBroadcaster() {
  for (const [id, c] of clients.entries()) if (c.role === "broadcaster") return id;
  return null;
}

// BFS to find first node with capacity < limit, optionally excluding a set of node ids
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

// choose backup parent (used earlier, kept for compatibility)
function chooseBackupParent(parentId) {
  if (!parentId) return findRootBroadcaster();
  const parent = clients.get(parentId);
  if (!parent) return findRootBroadcaster();
  if (parent.parentId) return parent.parentId;
  return findRootBroadcaster();
}

// MAIN: handle new connection
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

    // heartbeat from client
    if (type === "heartbeat") { entry.lastSeen = Date.now(); return; }

    // register
    if (type === "register") {
      entry.role = role || "listener";
      if (customId) entry.customId = customId;

      if (entry.role === "broadcaster") {
        console.log("▶ broadcaster registered:", id, entry.nodeLabel);
        safeSend(ws, { type: "registered-as-broadcaster", id, nodeLabel: entry.nodeLabel });
        // attempt to attach any rootless nodes
        for (const [cid, c] of clients.entries()) {
          if (c.role === "listener" && !c.parentId) assignParentFor(cid);
        }
      } else {
        // listener: assign parent via BFS
        assignParentFor(id);
      }
      return;
    }

    // signaling messages -> forward to target
    if (["offer","answer","candidate"].includes(type) && target) {
      const t = clients.get(target);
      if (t) safeSend(t.ws, { type, from: id, payload });
      return;
    }

    // broadcaster commands/metadata -> broadcast to all clients (control channel)
    if (type === "cmd" && entry.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) safeSend(c.ws, { type: "cmd", cmd: payload });
      return;
    }
    if (type === "metadata" && entry.role === "broadcaster") {
      for (const [cid, c] of clients.entries()) safeSend(c.ws, { type: "metadata", ...payload });
      return;
    }

    // room-message -> forward to children
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
    // remove from parent's children set
    if (c.parentId) {
      const parent = clients.get(c.parentId);
      if (parent) {
        parent.children.delete(id);
        safeSend(parent.ws, { type: "child-left", id, nodeLabel: c.nodeLabel });
      }
    }
    // Reassign each child of the leaving node
    const children = Array.from(c.children);
    for (const ch of children) {
      // detach child
      const child = clients.get(ch);
      if (!child) continue;
      child.parentId = null;
      // find new parent; exclude the leaving node and the child itself to avoid cycles
      const exclude = new Set([id, ch]);
      const newParent = findParentNode(exclude);
      if (newParent) {
        child.parentId = newParent;
        clients.get(newParent).children.add(ch);
        // notify new parent to create offer
        safeSend(clients.get(newParent).ws, { type: "listener-joined", id: ch, childNodeLabel: child.nodeLabel });
        // tell child it's been reassigned and who new parent is
        safeSend(child.ws, { type: "reassigned", newParent });
        // update child's backup parent if needed
        child.backupParent = chooseBackupParent(newParent);
        console.log(`reassigned child ${child.nodeLabel} -> new parent ${clients.get(newParent).nodeLabel}`);
      } else {
        // no parent found (no broadcaster online or full), inform child to wait
        safeSend(child.ws, { type: "reassigned", newParent: null });
        console.log(`child ${child.nodeLabel} remains rootless (waiting for root)`);
      }
    }

    clients.delete(id);
  });

  ws.on("error", (err) => {
    console.warn("ws error for", id, err);
  });
});

// assignParentFor: helper to assign parent to a node (used on register or rebalancing)
function assignParentFor(childId) {
  const child = clients.get(childId);
  if (!child) return;
  // find parent
  const parentId = findParentNode(new Set());
  if (!parentId) {
    child.parentId = null;
    safeSend(child.ws, { type: "room-assigned", nodeLabel: child.nodeLabel, parentId: null });
    console.log(`listener ${child.nodeLabel} assigned temporary (no root yet)`);
    return;
  }
  child.parentId = parentId;
  clients.get(parentId).children.add(childId);
  child.backupParent = chooseBackupParent(parentId);
  safeSend(child.ws, { type: "room-assigned", nodeLabel: child.nodeLabel, parentId });
  safeSend(clients.get(parentId).ws, { type: "listener-joined", id: childId, childNodeLabel: child.nodeLabel });
  console.log(`listener ${child.nodeLabel} -> parent ${clients.get(parentId).nodeLabel} (backup ${child.backupParent ? clients.get(child.backupParent)?.nodeLabel : 'none'})`);
}

// REBALANCING: move children from overloaded nodes to less loaded ones
function rebalance() {
  // build array of candidate parents sorted by load asc
  const candidates = [];
  for (const [id, c] of clients.entries()) {
    // only nodes that can be parents (broadcaster or listener)
    if (!c.role) continue;
    const limit = (c.role === "broadcaster") ? ROOT_CHILD_LIMIT : MAX_CHILDREN_PER_NODE;
    candidates.push({ id, load: c.children.size, limit });
  }
  // sort by load ascending (prefer less loaded)
  candidates.sort((a, b) => a.load - b.load);

  // try to move children from heavy nodes (>limit) to light nodes (<limit)
  for (const [id, c] of clients.entries()) {
    const limit = (c.role === "broadcaster") ? ROOT_CHILD_LIMIT : MAX_CHILDREN_PER_NODE;
    if ((c.children.size || 0) <= limit) continue; // ok
    const overflow = Array.from(c.children).slice(limit); // children to move
    for (const childId of overflow) {
      // find a candidate with room excluding current node and child itself
      const dest = candidates.find(x => x.id !== id && x.load < x.limit);
      if (!dest) break;
      // perform move
      c.children.delete(childId);
      const child = clients.get(childId);
      if (!child) continue;
      // remove from old parent and add to dest parent
      child.parentId = dest.id;
      clients.get(dest.id).children.add(childId);
      // update loads in candidates array
      dest.load++;
      // notify dest parent to create offer and child to expect new parent
      safeSend(clients.get(dest.id).ws, { type: "listener-joined", id: childId, childNodeLabel: child.nodeLabel });
      safeSend(child.ws, { type: "reassigned", newParent: dest.id });
      console.log(`rebalanced child ${child.nodeLabel} -> ${clients.get(dest.id).nodeLabel}`);
    }
  }
}

// heartbeat sweep: kill nodes that didn't heartbeat in time
function heartbeatSweep() {
  const now = Date.now();
  for (const [id, c] of clients.entries()) {
    if (!c.lastSeen) c.lastSeen = now;
    if ((now - c.lastSeen) > HEARTBEAT_TIMEOUT) {
      console.log(`heartbeat timeout for ${id} ${c.nodeLabel} — terminating ws`);
      try { c.ws.terminate(); } catch (e) {}
      // connection close handler will reassign children
    }
  }
}

// start periodic tasks
setInterval(heartbeatSweep, 5000);
setInterval(rebalance, REBALANCE_INTERVAL);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Signaling server listening on", PORT));
