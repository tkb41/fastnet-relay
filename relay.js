// Fastnet lobby + relay server.
// Browsers can't accept inbound connections, so every player (host included)
// dials this relay over WebSocket. The relay owns room codes and forwards
// Godot multiplayer packets between peers. Game logic stays host-authoritative
// in Godot; the relay never inspects game payloads.
//
// Control messages are JSON text frames:
//   C->S {"op":"host"}                      create a room; you become peer 1
//   C->S {"op":"join","room":"ABCD"}        join a room
//   S->C {"op":"hosted","room":"ABCD","id":1}
//   S->C {"op":"joined","room":"ABCD","id":<int>,"peers":[1,...]}
//   S->C {"op":"peer_joined","id":<int>} / {"op":"peer_left","id":<int>}
//   S->C {"op":"error","message":"..."}     / {"op":"room_closed"}
// Game packets are binary frames: [u8 channel/mode][i32 LE peer][payload]
//   C->S peer = target (0 = broadcast, -N = all except N)
//   S->C peer = source
import { WebSocketServer } from "ws";
import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 4);
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const rooms = new Map(); // code -> { peers: Map<id, ws>, created }

function code() {
  for (;;) {
    let c = "";
    for (let i = 0; i < 4; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function newPeerId(room) {
  for (;;) { const id = 2 + Math.floor(Math.random() * 0x7ffffff0); if (!room.peers.has(id)) return id; }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size })); }
  res.writeHead(200, { "content-type": "text/plain" }); res.end("fastnet relay\n");
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (data, isBinary) => {
    if (isBinary) return relay(ws, data);
    let msg; try { msg = JSON.parse(data.toString()); } catch { return send(ws, { op: "error", message: "bad json" }); }
    if (ws.room) return send(ws, { op: "error", message: "already in a room" });
    if (msg.op === "host") {
      const c = code();
      const room = { peers: new Map([[1, ws]]), created: Date.now() };
      rooms.set(c, room); ws.room = c; ws.peerId = 1;
      send(ws, { op: "hosted", room: c, id: 1 });
      log(`room ${c} hosted`);
    } else if (msg.op === "join") {
      const c = String(msg.room || "").toUpperCase().trim();
      const room = rooms.get(c);
      if (!room) return send(ws, { op: "error", message: `No room ${c}` });
      if (room.peers.size >= MAX_PLAYERS) return send(ws, { op: "error", message: "Room is full" });
      const id = newPeerId(room);
      const existing = [...room.peers.keys()];
      for (const other of room.peers.values()) send(other, { op: "peer_joined", id });
      room.peers.set(id, ws); ws.room = c; ws.peerId = id;
      send(ws, { op: "joined", room: c, id, peers: existing });
      log(`room ${c}: peer ${id} joined (${room.peers.size})`);
    } else send(ws, { op: "error", message: "unknown op" });
  });
  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

function relay(ws, data) {
  const room = rooms.get(ws.room);
  if (!room || data.length < 5) return;
  const target = data.readInt32LE(1);
  const out = Buffer.from(data); // copy, then stamp source id
  out.writeInt32LE(ws.peerId, 1);
  if (target > 0) { const t = room.peers.get(target); if (t && t.readyState === 1) t.send(out); return; }
  for (const [id, peer] of room.peers) {
    if (id === ws.peerId || (target < 0 && id === -target)) continue;
    if (peer.readyState === 1) peer.send(out);
  }
}

function leave(ws) {
  const room = rooms.get(ws.room);
  if (!room || !room.peers.has(ws.peerId)) return;
  room.peers.delete(ws.peerId);
  if (ws.peerId === 1) {
    for (const p of room.peers.values()) { send(p, { op: "room_closed" }); p.close(); }
    rooms.delete(ws.room); log(`room ${ws.room} closed`);
  } else {
    for (const p of room.peers.values()) send(p, { op: "peer_left", id: ws.peerId });
    log(`room ${ws.room}: peer ${ws.peerId} left`);
  }
}

setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 15000);
function log(m) { console.log(new Date().toISOString(), m); }
server.listen(PORT, () => log(`relay listening on :${PORT}`));
