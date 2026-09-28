# defuss-webrtc architecture

## 1. Manual signaling

`ManualPeer` wraps one `RTCPeerConnection` and one negotiated `RTCDataChannel`.

Offerer:

```text
createDataChannel
  -> createOffer
  -> setLocalDescription
  -> wait iceGatheringState=complete
  -> export complete SDP as offer JSON
```

Answerer:

```text
import offer JSON
  -> setRemoteDescription
  -> createAnswer
  -> setLocalDescription
  -> wait iceGatheringState=complete
  -> export complete SDP as answer JSON
```

Offerer imports the answer with `setRemoteDescription`. There is no trickle ICE and therefore no live signaling service.

The exported `candidates` and `publicEndpoints` arrays are diagnostic projections of SDP. The SDP remains authoritative.

## 2. Identity

Three concepts stay separate:

```text
peerId       stable logical peer/replica identifier chosen by application/package
actorId      CRDT operation namespace; normally peerId
ICE address  transient host/srflx/relay transport locator
```

Do not key application identity or authorization by an IP address.

## 3. CRDT operation model

Every mutation creates one immutable operation:

```ts
{
  id: `${actor}#${seq}`,
  actor,
  seq,       // per-actor monotonic sequence
  clock,     // Lamport clock
  path,
  kind,
  ...payload
}
```

The operation set is a grow-only set keyed by `id`; duplicate delivery is therefore idempotent. Materialized state is a pure deterministic function of:

```text
(schema, operation-set)
```

This gives commutative/associative/idempotent replica merge by set union.

## 4. Per-schema semantics

### Register

Select max operation under total order:

```text
(clock, actor, seq)
```

Lamport clocks preserve happens-before; actor/seq provide deterministic concurrent tie-breaking.

### Counter

Initial value plus every unique `counter:add.delta`. The immutable op-set supplies idempotency.

### OR-set

Each add operation ID is a unique tag. A remove records exactly the tags observed for the value at removal time. Concurrent unseen adds therefore survive: add-wins observed-remove semantics.

Initial set values use deterministic synthetic tags.

### Map

Map key existence is an LWW lifecycle (`map:put` / `map:delete`). A `map:put` begins a new generation. Nested operations older than the winning put are ignored, preventing deleted nested state from silently reappearing when a key is recreated.

Nested writes automatically emit `map:put` if the key is currently absent.

### List

RGA-style element graph:

- inserts have immutable element IDs equal to their operation IDs;
- each insert references an `after` element ID;
- concurrent siblings are total-ordered by op order;
- removes are tombstones;
- `list:set` provides LWW value replacement without changing element identity.

Removed elements remain structural anchors so concurrent descendants stay reachable.

## 5. Anti-entropy

Each replica tracks, per actor:

```text
frontier(actor) = largest contiguous sequence 1..N present locally
```

It intentionally does **not** advertise a simple maximum sequence. If sequence 5 arrives before sequence 4, the frontier remains 3, so a later hello still requests/resends the missing prefix.

On attach/open each side sends:

```ts
{
  kind: "hello",
  docId,
  actorId,
  schema,             // exact canonical descriptor
  schemaFingerprint,
  vector,
  reply: false
}
```

The receiver:

1. rejects different document/schema;
2. replies once with its own vector;
3. sends all operations newer than the remote contiguous frontier.

Live incoming operations are deduplicated and gossiped to other attached channels.

## 6. Wire constraints

- reliable ordered `RTCDataChannel` only;
- JSON protocol `defuss-crdt/1`;
- default message limit: 64 KiB;
- operation batches chunked under that limit;
- send queue respects `RTCDataChannel.bufferedAmount`;
- exact schema canonical string gates synchronization.

## 7. Deliberate v0.1 exclusions

- TURN credential provisioning;
- signaling-server mode;
- durable peer contact files;
- op-log compaction/causal GC;
- Byzantine peer/authz model;
- binary wire codec;
- schema migration;
- partially reliable CRDT transport;
- WebRTC mesh topology management.

These are separable layers and should not be entangled with the minimal transport/CRDT core.
