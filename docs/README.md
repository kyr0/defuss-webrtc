# defuss-webrtc P2P chat example

A P2P chat between browsers: a tiny room signaling server brokers the WebRTC
offer/answer exchange, then all peers in a room connect to each other directly
(full mesh) and sync the chat state conflict-free via CRDTs over the data
channels. The server never sees chat traffic.

This folder is **self-contained**: the built library is vendored into
`docs/dist/`, so the folder can be served directly as a site root — including
as a GitHub Pages site ("Deploy from branch" → `/docs`). After rebuilding the
library with `npm run build`, refresh the vendored copy:

```bash
cp -R dist docs/dist
```

## Run it

Start the signaling server (see `server/README.md` for the API):

```bash
cd server && npm install && npm run dev   # http://localhost:8787
```

Serve this folder (ES modules don't load from `file://`):

```bash
npx serve docs          # or: python3 -m http.server 8000 --directory docs
```

Open `http://localhost:8000/` in two tabs, browsers or devices — every tab is
its own peer (identity lives in `sessionStorage`).

## Usage

1. Set a nickname.
2. Enter a room name and click **Create room** (you become its moderator) — or
   **Join room** / click **Join** on a room in the list.
3. The joining peer automatically offers to every existing member; everyone
   polls the server, answers the offers addressed to them, and within a few
   seconds every peer is connected to every other peer. Chat away.
4. **Save state** downloads your identity + full CRDT history. **Restore state**
   on another client impersonates that peer: same peer id, nickname and exact
   chat state.

The manual PEER.json file flow (fully serverless, no signal server at all) is
still available under "Advanced: manual signaling without a server".

The STUN server field defaults to Cloudflare's public STUN. Clear it for
same-machine/LAN testing (host candidates only).
