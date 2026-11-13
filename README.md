# fastnet-relay

WebSocket lobby/relay for **The Net** (Fastnet Shift Lab) online co-op. Holds 4-letter room codes and forwards
Godot multiplayer packets between players. Contains no game code or secrets.

- `npm ci && npm start` (PORT defaults to 8787; `/health` returns room count)
- Render: Web Service, Node, build `npm ci --omit=dev`, start `node relay.js` (or use `render.yaml`).
