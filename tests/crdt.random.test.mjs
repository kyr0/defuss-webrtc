import test from "node:test";
import assert from "node:assert/strict";
import { createCrdtDocument, defineSchema, register, counter, orSet, map, object, list } from "../dist/crdt/index.js";

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

function schema() {
  return defineSchema({
    title: register(""),
    count: counter(),
    tags: orSet([]),
    users: map(object({ name: register(""), score: counter() })),
    list: list([]),
  });
}

function mutate(doc, random, step) {
  const pick = Math.floor(random() * 8);
  const user = `u${Math.floor(random() * 4)}`;
  switch (pick) {
    case 0: doc.set(["title"], `${doc.actorId}:${step}`); break;
    case 1: doc.increment(["count"], Math.floor(random() * 7) - 3 || 1); break;
    case 2: doc.setAdd(["tags"], `t${Math.floor(random() * 5)}`); break;
    case 3: doc.setDelete(["tags"], `t${Math.floor(random() * 5)}`); break;
    case 4: doc.set(["users", user, "name"], `${user}:${step}`); break;
    case 5: doc.increment(["users", user, "score"], 1); break;
    case 6: {
      const length = doc.state.list.length;
      doc.listInsert(["list"], Math.floor(random() * (length + 1)), `${doc.actorId}:${step}`);
      break;
    }
    case 7: {
      const length = doc.state.list.length;
      if (length) doc.listDelete(["list"], Math.floor(random() * length));
      else doc.mapDelete(["users"], user);
      break;
    }
  }
}

test("randomized 3-replica op-set merges converge and are idempotent", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const s = schema();
    const docs = ["a", "b", "c"].map((actorId) => createCrdtDocument({ id: `r${seed}`, actorId, schema: s }));
    const random = rng(seed * 0x9e3779b1);
    for (let step = 0; step < 80; step++) mutate(docs[Math.floor(random() * docs.length)], random, step);

    const snapshots = docs.map((doc) => doc.export());
    docs[0].merge(snapshots[2]); docs[0].merge(snapshots[1]);
    docs[1].merge(snapshots[0]); docs[1].merge(snapshots[2]);
    docs[2].merge(snapshots[1]); docs[2].merge(snapshots[0]);

    assert.deepEqual(docs[0].state, docs[1].state, `seed=${seed}`);
    assert.deepEqual(docs[1].state, docs[2].state, `seed=${seed}`);
    const count = docs[0].operationCount;
    assert.equal(docs[0].merge(docs[1].export()), 0, `idempotency seed=${seed}`);
    assert.equal(docs[0].operationCount, count, `op count seed=${seed}`);
  }
});

test("version-vector frontier repairs an out-of-order actor gap on attach", async () => {
  const s = defineSchema({ count: counter() });
  const a = createCrdtDocument({ id: "gap", actorId: "a", schema: s });
  const b = createCrdtDocument({ id: "gap", actorId: "b", schema: s });
  a.increment(["count"], 1);
  a.increment(["count"], 2);
  const full = a.export();
  b.merge({ ...full, ops: [full.ops[1]] });
  assert.deepEqual(b.versionVector, { a: 0 });

  class Channel extends EventTarget {
    ordered = true; maxRetransmits = null; maxPacketLifeTime = null; readyState = "open";
    bufferedAmount = 0; bufferedAmountLowThreshold = 0; peer = null;
    send(data) { queueMicrotask(() => { const e = new Event("message"); Object.defineProperty(e, "data", { value: data }); this.peer.dispatchEvent(e); }); }
    close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  }
  const ca = new Channel(); const cb = new Channel(); ca.peer = cb; cb.peer = ca;
  a.attach(ca); b.attach(cb);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(b.state.count, 3);
  assert.deepEqual(b.versionVector, { a: 2 });
});
