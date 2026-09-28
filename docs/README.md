# defuss-webrtc P2P chat example

A P2P chat between browsers: a tiny room signaling server brokers the WebRTC
offer/answer exchange, then all peers in a room connect to each other directly
(full mesh) and sync the chat state conflict-free via CRDTs over the data
channels. The server never sees chat traffic.

Live: **https://kyr0.github.io/defuss-webrtc/** — it uses the hosted signaling
server `https://defuss-webrtc.vercel.app` by default.

The page imports the library from `./dist/`. `docs/dist/` is not committed:
the Pages workflow (`.github/workflows/pages.yml`) builds the library and
publishes `docs/` together with a fresh `dist/` on every push to `main`
(Settings → Pages → Source: "GitHub Actions").

The UI is built with [defuss-shadcn](https://github.com/kyr0/defuss-shadcn)
(plain HTML + design tokens, no build step), loaded from jsDelivr pinned to
`@0.9.1`. It follows the OS light/dark preference. `style.css` only holds the
page-specific layout (chat bubbles, lists, log) and uses the shadcn tokens.

## Run it locally

Build the library next to the page, then serve this folder (ES modules don't
load from `file://`):

```bash
npm run build && cp -R dist docs/dist
npx serve docs          # or: python3 -m http.server 8000 --directory docs
```

Open `http://localhost:8000/` in two tabs, browsers or devices — every tab is
its own peer (identity lives in `sessionStorage`).

The signal server URL defaults to the hosted `https://defuss-webrtc.vercel.app`.
To use your own, start one (see `server/README.md`) and enter its URL:

```bash
cd server && npm install && npm run dev   # then use http://localhost:8787
```

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

**Passwords (optional):** if the signal server was started with
`SERVER_PASSWORD`, enter it in *Server password*. Filling *Room password*
before **Create room** protects the new room; protected rooms show a
`password` badge in the list and need their password in the same field to
join.

The STUN server field defaults to Cloudflare's public STUN. Clear it for
same-machine/LAN testing (host candidates only).
