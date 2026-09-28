## `defuss-webrtc` API

### Manual signaling

```ts
const a = new ManualPeer();
const offer = await a.createOffer();
downloadSignalBundle(offer);

const offer = await readSignalFile(file);
const b = new ManualPeer();
const answer = await b.acceptOffer(offer);
downloadSignalBundle(answer);

await a.acceptAnswer(await readSignalFile(answerFile));
const channel = await a.waitForOpen();
```

Default ICE config: `stun:stun.cloudflare.com:3478`. Override `iceServers` to add TURN.

`offer.publicEndpoints` contains parsed `srflx` addresses. These are transport locators, not identities. Manual signaling is two-step and ephemeral: the peer connection that generated an offer must remain alive until its answer is imported.

Helpers:

```ts
parseSignalBundle(json)
serializeSignalBundle(bundle)
downloadSignalBundle(bundle, filename?)
readSignalFile(blob)
extractIceCandidates(sdp)
getServerReflexiveEndpoints(sdpOrBundle)
```

### Schema

```ts
const schema = defineSchema({
  name: register(""),
  count: counter(),
  tags: orSet<string>(),
  users: map(object({ name: register("") })),
  items: list<{ id: string }>(),
});
```

Aliases are also available through `crdt`: `crdt.schema`, `crdt.register`, `crdt.counter`, `crdt.set`, `crdt.object`, `crdt.map`, `crdt.list`.

### Document

```ts
const doc = createCrdtDocument({ id: "room", actorId: peer.peerId, schema });
doc.attach(channel); // reliable + ordered required

doc.set(["name"], "Alice");
doc.increment(["count"], 1);
doc.setAdd(["tags"], "local-first");
doc.setDelete(["tags"], "old");
doc.mapEnsure(["users"], "alice");
doc.mapDelete(["users"], "alice");
doc.listInsert(["items"], 0, { id: "x" });
doc.listSet(["items"], 0, { id: "y" });
doc.listDelete(["items"], 0);

const state = doc.state;
const unsubscribe = doc.subscribe(({ origin, ops, state }) => {});
const snapshot = doc.export();
doc.merge(snapshotOrJson);
```

Nested map keys are auto-created on nested mutations. `batch(fn)` batches wire/change notification; it is not rollback/transaction isolation.

### Merge model

- register: Lamport-LWW;
- counter: immutable unique deltas;
- set: observed-remove/add-wins OR-set;
- map: LWW key lifecycle, put starts a new nested generation;
- list: RGA-style identity/order + tombstones + LWW element replacement;
- global merge: immutable op-set union, dedupe by `actor#seq`.

Schema canonical equality is validated during hello before operations are accepted.
