# defuss-webrtc website

The project website, live at **https://kyr0.github.io/defuss-webrtc/**:

- `index.html` is the landing page. It explains signaling by room server and by
  hand, CRDT sync over the data channel, the two signaling servers and the room
  data model, and runs a CRDT merge explorer and the two-peer demo.
- `demo/` is the P2P chat demo: a room signaling server or a PEER.json file
  exchange sets up WebRTC data channels between every pair of peers (full
  mesh), and the chat state syncs conflict-free as a CRDT. The server never
  sees chat traffic.
- `assets/` holds the landing page's CSS and scripts, and `json.js`, the JSON
  highlighter both pages use.
- `dist/` is a committed copy of the library build.

The demo uses the hosted signaling server `https://defuss-webrtc.vercel.app`
by default.

GitHub Pages serves this folder from `main` as committed (Settings → Pages →
Source: "Deploy from a branch", `main`, `/docs`); `.nojekyll` skips the Jekyll
pass. There is no build step, so both pages import the library from `./dist/`.
`make site` rebuilds that copy, and `make test` fails while it differs from a
fresh build, so a stale library cannot ship unnoticed. A Pages workflow that
builds on every push avoided the copy but needed its own deploy pipeline;
serving the folder directly keeps the published page equal to what is in the
repository.

The UI is built with [defuss-shadcn](https://github.com/kyr0/defuss-shadcn)
(plain HTML, design tokens, no build step), loaded from jsDelivr at `0.9.8`
and pinned by Subresource Integrity. The layout follows the defuss-store and
defuss-dataview sites. The theme switch on the landing page repaints both demo
frames and is saved under the `defuss-shadcn-theme` key; without a saved
choice, both pages follow the OS preference.

## Run it locally

ES modules do not load from `file://`, so serve the folder. After changing the
library in `src/`, run `make site` first so the pages pick up the change:

```bash
bun run dev   # bunx serve on http://localhost:3000, or the free port it prints
```

`serve.json` in the repository root makes `serve` redirect `/demo` to
`/demo/`, as GitHub Pages does; without it the demo's relative URLs break.

To use your own signaling server, start one (see `server/README.md`) and enter
its URL in the demo:

```bash
cd server && npm install && npm run dev   # then use http://localhost:8787
```

## The two-peer demo

The landing page loads `demo/?peer=a&room=…` and `demo/?peer=b&room=…` side by
side, but only after a click, so a visitor who only reads sends no request to
the signaling server. `peer` names an identity slot: the HTML spec gives every
tab one `sessionStorage` per origin, and same-origin frames share it, so each
slot keeps its peer id under its own key. `room` pre-fills the room name; the
landing page picks a fresh one per page load. Opened without parameters, the
demo is one peer per tab.

The defuss-shadcn skill documents a Teaser component for this start screen,
but the published 0.9.8 release does not ship it; the page uses a card with a
start button that swaps the frames in.

## Using the demo

The demo has two tabs. **Connect** walks through the connection one step at a
time and becomes **Chat** once connected; **Peer devtools** sits next to it
with the connections, the chat's CRDT document (`roomDoc.state`, live), the
log, and save and restore. The steps:

1. **Mode:** a room server, or manual files with no server at all.
2. **Signal server** (room mode only): URL and optional server password.
3. **This peer:** nickname and STUN servers; the peer id is shown here.
4. **Room:** create a room (you become its moderator) or join one, by name or
   from the list. In manual mode this step is the PEER.json exchange instead:
   Peer A downloads an offer, Peer B uploads it and gets an answer file, Peer A
   uploads the answer.

The chat replaces the steps as soon as this peer has a chat document: on
entering a room, or when the first file-signaled data channel opens. A badge
shows how many peers are connected. Peers connected by files have no room to
name their document, so they share the document id `manual`. **Leave room**
(or **Disconnect** in manual mode) returns to the last step.

**Save state** downloads your identity and the chat's full CRDT history;
**Restore state** on another client continues as that peer: same peer id,
nickname and chat state.

### Reconnection

Peers heal on their own; the CRDT merges whatever both sides wrote while apart
as soon as a link is back:

- **Lost links** (network drop, sleep, ICE failure) are detected through the
  data channel and `RTCPeerConnection.connectionState` ("disconnected" gets a
  short grace period) and re-established; the later joiner of a pair re-offers,
  with backoff. Unanswered offers are withdrawn and retried.
- **Offline:** signaling pauses and a badge shows the state; you can keep
  writing. The `online` event resyncs immediately.
- **Hidden tabs** poll every 15 s instead of every 2 s (still inside the
  server's 90 s presence timeout) and resync the moment they are visible again.
- **Dropped by the server** (asleep for more than 90 s, for example): the tab
  rejoins on its own instead of leaving the room.
- **Reloads** keep the peer id: joining again replaces the stale session the
  server still lists. Each page load writes as its own CRDT actor
  (`peerId#<load id>`), so messages written right after a reload never collide
  with the ones from before it.

Messages are displayed chronologically (by their timestamp; CRDT order breaks
ties), so text written while offline lands where it belongs in time.

**Passwords (optional):** if the signaling server was started with
`SERVER_PASSWORD`, enter it in *Server password*. Filling *Room password*
before **Create room** protects the new room; protected rooms show a
`password` badge in the list and need their password in the same field to
join.

The STUN field defaults to Cloudflare's public STUN server. Clear it for
same-machine or LAN testing (host candidates only).

## Tests

`e2e/browser/site.spec.mjs` drives the landing page and `chat.spec.mjs` the
demo, both in real Chromium against a local signaling server (`make e2e`).
