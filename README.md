# defuss-webrtc

Serverless/manual-signaling WebRTC data channels plus a schema-aware CRDT sync layer for defuss.

## What this package actually does

`defuss-webrtc` uses WebRTC ICE normally, but replaces the signaling server with files/messages exchanged out of band:

1. Peer A creates an **offer JSON** after ICE gathering is complete.
2. A sends that JSON via WhatsApp, email, QR/file transfer, etc.
3. Peer B imports it and creates an **answer JSON**.
4. B sends the answer JSON back.
5. A imports it; ICE selects a working candidate pair and the `RTCDataChannel` opens.
6. A schema-aware CRDT can then synchronize state over that data channel.

The default STUN server is Cloudflare's public `stun:stun.cloudflare.com:3478`; pass `iceServers` to override it or add TURN.

### Important networking constraints

- **IP address is not peer identity.** `peerId` is the logical replica/peer identity; STUN-derived `srflx` IP:port values are transient network locators.
- **The JSON is signaling state, not a durable contact card.** The originating `RTCPeerConnection` must remain alive while its offer waits for an answer. ICE credentials, NAT bindings and candidates are session-scoped/ephemeral.
- **STUN-only is best-effort.** Some NAT/firewall combinations cannot establish a direct path. Add TURN credentials through `iceServers` if connectivity must be reliable.
- Offer/answer JSON contains SDP, ICE credentials, candidate addresses and DTLS fingerprints. Treat it as short-lived sensitive session material.

## Install

```bash
bun add defuss-webrtc
```

The package has no runtime dependencies.

## Manual WebRTC signaling

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

No TURN credentials are bundled by this package.

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

## Example app + signaling server

- `docs/` is a self-contained P2P chat example (usable as a GitHub Pages site) that syncs CRDT chat state over data channels in a full peer mesh.
- `server/` is a tiny Express rendezvous server (rooms, offer/answer brokering, presence) that the example uses instead of manual file exchange. See `server/README.md` for the API spec.
