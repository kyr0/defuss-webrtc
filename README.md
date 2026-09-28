# defuss-webrtc

WebRTC data channels with pluggable signaling — **out of band** (files/messages, no server at all) or through a tiny **room signaling server** — plus a schema-aware CRDT sync layer for defuss.

## What this package does

`defuss-webrtc` uses WebRTC ICE normally. The only thing peers need a channel for is *signaling*: exchanging one offer and one answer. `ManualPeer` makes that exchange transport-agnostic by producing a self-contained **`SignalBundle`** JSON — complete SDP after ICE gathering, no trickle ICE — that can travel over any channel:

| | Out-of-band signaling | Server-based signaling |
| --- | --- | --- |
| Transport | files/messages: WhatsApp, email, QR, USB stick, … | HTTP rendezvous server |
| Infrastructure | none | [`server/`](server/README.md) (Express) or [`vercel/`](vercel/README.md) (Vercel Functions + Redis), both in this repo |
| Topology | one peer pair per exchange | rooms; every joiner is meshed with every member automatically |
| Setup time | a human round trip per pair | seconds |
| Access control | whoever receives the file | optional server password and per-room passwords |

Either way the flow is the same underneath:

1. Peer A creates an **offer bundle** after ICE gathering is complete.
2. The offer reaches peer B — by hand, or via the server.
3. Peer B imports it and creates an **answer bundle**.
4. The answer travels back to A the same way.
5. A imports it; ICE selects a working candidate pair and the `RTCDataChannel` opens.
6. A schema-aware CRDT can then synchronize state over that data channel.

After signaling, both modes are identical: application traffic flows peer to peer, and a signaling server never sees it.

The default STUN server is Cloudflare's public `stun:stun.cloudflare.com:3478`; pass `iceServers` to override it or add TURN.

### Important networking constraints

- **IP address is not peer identity.** `peerId` is the logical replica/peer identity; STUN-derived `srflx` IP:port values are transient network locators.
- **The JSON is signaling state, not a durable contact card.** The originating `RTCPeerConnection` must remain alive while its offer waits for an answer. ICE credentials, NAT bindings and candidates are session-scoped/ephemeral.
- **STUN-only is best-effort.** Some NAT/firewall combinations cannot establish a direct path. Add TURN credentials through `iceServers` if connectivity must be reliable.
- Offer/answer JSON contains SDP, ICE credentials, candidate addresses and DTLS fingerprints. Treat it as short-lived sensitive session material — including when it passes through a signaling server, which should therefore sit behind TLS.

## Install

```bash
bun add defuss-webrtc
```

The package has no runtime dependencies.

## Out-of-band signaling

No server involved: the bundles are exchanged by hand.

### Peer A

```ts
import {
  ManualPeer,
  downloadSignalBundle,
  readSignalFile,
} from "defuss-webrtc/webrtc";

const peer = new ManualPeer();
const offer = await peer.createOffer();

downloadSignalBundle(offer); // send this JSON file to peer B
console.log(offer.publicEndpoints); // STUN-derived srflx endpoints, if any

// Later, after B returns an answer file:
const answer = await readSignalFile(answerFile);
await peer.acceptAnswer(answer);
const channel = await peer.waitForOpen();

channel.send("hello");
```

### Peer B

```ts
import {
  ManualPeer,
  downloadSignalBundle,
  readSignalFile,
} from "defuss-webrtc/webrtc";

const offer = await readSignalFile(offerFile);
const peer = new ManualPeer();
const answer = await peer.acceptOffer(offer);

downloadSignalBundle(answer); // return this JSON file to peer A

const channel = await peer.waitForOpen();
channel.addEventListener("message", (event) => {
  console.log(event.data);
});
```

### TURN fallback

```ts
const peer = new ManualPeer({
  iceServers: [
    { urls: "stun:stun.cloudflare.com:3478" },
    {
      urls: ["turn:turn.example.com:3478?transport=udp"],
      username: "ephemeral-user",
      credential: "ephemeral-password",
    },
  ],
});
```

No TURN credentials are bundled by this package. `iceServers` works the same for both signaling modes.

## Server-based signaling

The same bundles can be brokered by a room signaling server. This repo ships two interchangeable implementations of one protocol ([`server/PROTOCOL.md`](server/PROTOCOL.md) is normative); they return identical responses:

- [`server/`](server/README.md) — Express, in-memory state. `cd server && npm install && npm run dev`.
- [`vercel/`](vercel/README.md) — Vercel Functions with Upstash Redis for shared state across instances.

Rooms follow one rule: **the joiner offers to every existing member**, members answer the offers addressed to them, and a full mesh forms within a few polls. Polling doubles as a presence heartbeat; silent members are dropped after 90 s.

The package does not include a room client yet — signaling over the server is plain `fetch` around `ManualPeer`:

```ts
import { ManualPeer } from "defuss-webrtc/webrtc";

const base = "https://signal.example.com/v1/rooms/lobby";
const me = { peerId: crypto.randomUUID(), nickname: "Alice" };
const headers: Record<string, string> = { "Content-Type": "application/json" };
// Only for password-protected servers/rooms (values are percent-encoded):
// headers["X-Server-Password"] = encodeURIComponent(serverPassword);
// headers["X-Room-Password"] = encodeURIComponent(roomPassword);

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json()).message);
  return res.json();
}

// Join: one fresh offer per existing member.
// (To create the room instead: await api("POST", "", { ...me, password: "optional" }).)
const { members } = await api("GET", "/members");
const pending = new Map<string, ManualPeer>(); // sessionId -> peer awaiting an answer
const offers = [];
for (const member of members) {
  const peer = new ManualPeer({ peerId: me.peerId });
  const bundle = await peer.createOffer({ metadata: { nickname: me.nickname } });
  pending.set(bundle.sessionId, peer);
  offers.push({ to: member.peerId, bundle });
}
await api("POST", "/join", { ...me, offers });

// Poll: complete my offers, answer offers addressed to me.
const answered = new Set<string>();
setInterval(async () => {
  const state = await api("GET", `/members?peerId=${encodeURIComponent(me.peerId)}`);
  for (const answer of state.answers) {
    const peer = answer.to === me.peerId ? pending.get(answer.sessionId) : undefined;
    if (!peer) continue;
    pending.delete(answer.sessionId);
    await peer.acceptAnswer(answer.bundle);
    peer.waitForOpen().then((channel) => doc.attach(channel)); // doc: a CrdtDocument, see below
  }
  for (const offer of state.offers) {
    if (offer.to !== me.peerId || answered.has(offer.sessionId)) continue;
    answered.add(offer.sessionId);
    const peer = new ManualPeer({ peerId: me.peerId });
    const bundle = await peer.acceptOffer(offer.bundle, { metadata: { nickname: me.nickname } });
    await api("POST", "/answers", { from: me.peerId, to: offer.from, sessionId: offer.sessionId, bundle });
    peer.waitForOpen().then((channel) => doc.attach(channel));
  }
}, 2000);
```

This sketch leaves out leaving (`POST /leave`), error handling and *mesh repair* for peers that joined at the same moment (PROTOCOL.md §6.4). [`docs/app.js`](docs/app.js) is the complete reference client.

### Passwords (optional)

- **Server password:** start the server with `SERVER_PASSWORD=…`; every request must then send `X-Server-Password`.
- **Room password:** pass `password` when creating a room; every later request for that room must send `X-Room-Password`. `GET /v1/rooms` marks such rooms `protected: true`.

Passwords are shared secrets, not per-member accounts — see PROTOCOL.md §2.1 and §8.

## Schema-aware CRDT

The schema is executable metadata for the merge layer: each path has explicit conflict semantics.

```ts
import {
  createCrdtDocument,
  defineSchema,
  register,
  counter,
  orSet,
  map,
  object,
  list,
} from "defuss-webrtc/crdt";

const schema = defineSchema({
  title: register("Untitled"),      // Lamport-LWW register
  votes: counter(0),                // commutative delta counter
  tags: orSet<string>([]),          // observed-remove, add-wins set
  users: map(object({               // LWW key lifecycle + nested CRDTs
    name: register(""),
    score: counter(0),
  })),
  messages: list<{ text: string }>([]), // RGA-style sequence + tombstones
});

const doc = createCrdtDocument({
  id: "room-42",
  actorId: peer.peerId,
  schema,
});

doc.attach(await peer.waitForOpen());

doc.set(["title"], "Shared notes");
doc.increment(["votes"], 1);
doc.setAdd(["tags"], "p2p");
doc.set(["users", "alice", "name"], "Alice"); // map key auto-created
doc.listInsert(["messages"], 0, { text: "hello" });

console.log(doc.state);
```

### API semantics

| Schema node | Mutation API | Merge semantics |
| --- | --- | --- |
| `register(initial)` | `doc.set(path, value)` | Lamport-LWW; `(clock, actor, seq)` total-order tie break |
| `counter(initial)` | `doc.increment(path, delta)` | unique immutable deltas summed once |
| `orSet(initial)` | `doc.setAdd`, `doc.setDelete` | observed-remove/add-wins OR-set |
| `map(valueSchema)` | nested mutations, `mapEnsure`, `mapDelete` | LWW key lifecycle; re-put starts a fresh nested generation |
| `object(fields)` | child mutation | static field container |
| `list(initial)` | `listInsert`, `listSet`, `listDelete` | RGA-style immutable element IDs + tombstones |

Schema equality is checked using the exact canonical schema descriptor during the CRDT hello handshake. `schemaFingerprint` is only a compact diagnostic fingerprint; exact canonical equality is what gates synchronization.

## Offline/import merge

```ts
const snapshot = doc.export();
localStorage.setItem("room-42", JSON.stringify(snapshot));

const other = createCrdtDocument({ id: "room-42", actorId: "new-peer", schema });
other.merge(localStorage.getItem("room-42")!);
```

Snapshots currently contain the immutable op-set. This makes merge/idempotence simple and correct but means the log grows with mutations. Compaction/checkpointing is intentionally not implemented in v0.1 because safe compaction requires causal stability/peer-retirement semantics.

## Multi-peer

A document may attach to multiple reliable ordered data channels. Newly learned operations are deduplicated by `(actor, seq)` and gossiped to the other attached channels. Version-vector frontiers repair missing prefixes on attach/reconnect.

```ts
doc.attach(channelToB);
doc.attach(channelToC);
```

## Reliability/backpressure

`CrdtDocument.attach()` requires a **reliable ordered** `RTCDataChannel`. It rejects channels configured with `maxRetransmits` or `maxPacketLifeTime`. Messages are capped at 64 KiB by default and queued while `bufferedAmount` is high; both limits are configurable.

## Verification

The package includes:

- strict TypeScript build;
- deterministic convergence tests;
- OR-set observed-remove/add-wins tests;
- map generation/delete/recreate tests;
- RGA list tests;
- fake-data-channel anti-entropy tests;
- version-vector gap repair test;
- 60 randomized three-replica simulations × 80 mutations;
- ICE candidate/signaling JSON parser tests.

Run:

```bash
npm test
```

A browser smoke page is included at `tests/browser-smoke.html` for a real same-browser two-peer WebRTC check. It is deliberately separate from the deterministic Node test suite.

## Repository layout

- `src/` — the `defuss-webrtc` package: `ManualPeer` + signal bundles (`defuss-webrtc/webrtc`) and the CRDT layer (`defuss-webrtc/crdt`).
- `docs/` — a P2P chat example (usable as a GitHub Pages site) that supports **both** signaling modes: rooms via a signaling server, or the manual PEER.json file exchange under "Advanced". It syncs CRDT chat state over data channels in a full peer mesh.
- `server/` — Express room signaling server (rooms, offer/answer brokering, presence, optional passwords). `server/PROTOCOL.md` is the protocol spec.
- `vercel/` — the same protocol as Vercel Functions with Upstash Redis, for serverless deployments.
