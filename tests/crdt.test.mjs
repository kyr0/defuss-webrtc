import test from "node:test";
import assert from "node:assert/strict";
import {
  createCrdtDocument,
  defineSchema,
  register,
  counter,
  orSet,
  map,
  object,
  list,
  canonicalSchema,
  schemaFingerprint,
} from "../dist/crdt/index.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSchema() {
  return defineSchema({
    title: register(""),
    count: counter(0),
    tags: orSet([]),
    users: map(object({
      name: register(""),
      score: counter(0),
    })),
    items: list([]),
  });
}

test("schema canonicalization is stable across object field insertion order", () => {
  const a = defineSchema({ b: counter(), a: register("x") });
  const b = defineSchema({ a: register("x"), b: counter() });
  assert.equal(canonicalSchema(a), canonicalSchema(b));
  assert.equal(schemaFingerprint(a), schemaFingerprint(b));
});

test("concurrent operation sets converge independent of merge direction", () => {
  const schema = makeSchema();
  const a = createCrdtDocument({ id: "doc", actorId: "actor-a", schema });
  const b = createCrdtDocument({ id: "doc", actorId: "actor-b", schema });

  a.set(["title"], "from-a");
  a.increment(["count"], 2);
  a.setAdd(["tags"], "a");
  a.set(["users", "alice", "name"], "Alice");
  a.increment(["users", "alice", "score"], 3);
  a.listInsert(["items"], 0, { text: "A" });

  b.set(["title"], "from-b");
  b.increment(["count"], 5);
  b.setAdd(["tags"], "b");
  b.set(["users", "bob", "name"], "Bob");
  b.listInsert(["items"], 0, { text: "B" });

  const aBefore = a.export();
  const bBefore = b.export();
  a.merge(bBefore);
  b.merge(aBefore);

  assert.deepEqual(a.state, b.state);
  assert.equal(a.state.count, 7);
  assert.deepEqual(a.state.tags, ["a", "b"]);
  assert.equal(a.state.users.alice.name, "Alice");
  assert.equal(a.state.users.alice.score, 3);
  assert.equal(a.state.users.bob.name, "Bob");
  assert.equal(a.state.items.length, 2);
});

test("OR-set removal is observed-remove/add-wins", () => {
  const schema = defineSchema({ tags: orSet([]) });
  const a = createCrdtDocument({ id: "set", actorId: "a", schema });
  const b = createCrdtDocument({ id: "set", actorId: "b", schema });

  a.setAdd(["tags"], "x");
  b.merge(a.export());
  b.setDelete(["tags"], "x");
  a.setAdd(["tags"], "x");

  const sa = a.export();
  const sb = b.export();
  a.merge(sb);
  b.merge(sa);

  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.state.tags, ["x"]);
});

test("LWW map deletion hides prior generation and a later write recreates it", () => {
  const schema = defineSchema({ users: map(object({ name: register("") })) });
  const a = createCrdtDocument({ id: "map", actorId: "a", schema });
  const b = createCrdtDocument({ id: "map", actorId: "b", schema });

  a.set(["users", "alice", "name"], "v1");
  b.merge(a.export());
  assert.equal(b.state.users.alice.name, "v1");

  b.mapDelete(["users"], "alice");
  a.merge(b.export());
  assert.equal(a.state.users.alice, undefined);

  a.set(["users", "alice", "name"], "v2");
  b.merge(a.export());
  assert.equal(b.state.users.alice.name, "v2");
});

test("RGA-style list converges for concurrent inserts and supports tombstones", () => {
  const schema = defineSchema({ items: list(["base"]) });
  const a = createCrdtDocument({ id: "list", actorId: "a", schema });
  const b = createCrdtDocument({ id: "list", actorId: "b", schema });

  a.listInsert(["items"], 0, "A");
  b.listInsert(["items"], 0, "B");
  const sa = a.export();
  const sb = b.export();
  a.merge(sb);
  b.merge(sa);
  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.state.items.slice().sort(), ["A", "B", "base"].sort());

  a.listDelete(["items"], 1);
  b.merge(a.export());
  assert.deepEqual(a.state, b.state);
});

class FakeDataChannel extends EventTarget {
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer = null;

  send(data) {
    if (!this.peer || this.readyState !== "open") throw new Error("channel closed");
    queueMicrotask(() => {
      if (this.peer.readyState !== "open") return;
      const event = new Event("message");
      Object.defineProperty(event, "data", { value: data });
      this.peer.dispatchEvent(event);
    });
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

function channelPair() {
  const a = new FakeDataChannel();
  const b = new FakeDataChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

test("data-channel anti-entropy synchronizes divergent replicas and live deltas", async () => {
  const schema = makeSchema();
  const a = createCrdtDocument({ id: "wire", actorId: "a", schema });
  const b = createCrdtDocument({ id: "wire", actorId: "b", schema });
  a.increment(["count"], 2);
  a.setAdd(["tags"], "a");
  b.increment(["count"], 5);
  b.setAdd(["tags"], "b");

  const [ca, cb] = channelPair();
  a.attach(ca);
  b.attach(cb);
  await tick(10);

  assert.deepEqual(a.state, b.state);
  assert.equal(a.state.count, 7);
  assert.deepEqual(a.state.tags, ["a", "b"]);

  a.increment(["count"], 4);
  b.set(["title"], "live");
  await tick(10);
  assert.deepEqual(a.state, b.state);
  assert.equal(a.state.count, 11);
  assert.equal(a.state.title, "live");
});

test("schema mismatch is rejected before applying remote operations", async () => {
  const a = createCrdtDocument({ id: "mismatch", actorId: "a", schema: defineSchema({ x: counter() }) });
  const b = createCrdtDocument({ id: "mismatch", actorId: "b", schema: defineSchema({ x: register(0) }) });
  const errors = [];
  a.onError((error) => errors.push(error));
  b.onError((error) => errors.push(error));
  const [ca, cb] = channelPair();
  a.attach(ca);
  b.attach(cb);
  await tick(10);
  assert.ok(errors.some((error) => error.code === "SCHEMA_MISMATCH" || error.code === "REMOTE_SCHEMA_MISMATCH"));
});

test("state is a fresh copy, cached until any op changes it, and change.state is the event-time state", () => {
  const schema = makeSchema();
  const a = createCrdtDocument({ id: "doc", actorId: "a", schema });
  const b = createCrdtDocument({ id: "doc", actorId: "b", schema });

  const first = a.state;
  first.title = "mutated by caller";
  first.users.ghost = { name: "x", score: 1 };
  assert.equal(a.state.title, "", "callers cannot mutate the document through state");
  assert.deepEqual(a.state.users, {});
  assert.notEqual(a.state, a.state, "every read returns a fresh object");

  const seen = [];
  a.subscribe((change) => seen.push([change.origin, change.state.title]));
  a.set(["title"], "local");
  assert.equal(a.state.title, "local", "local ops invalidate the cache");
  a.set(["title"], "local 2");
  assert.deepEqual(seen, [["local", "local"], ["local", "local 2"]], "change.state is the state at event time");

  b.set(["title"], "remote");
  b.increment(["count"], 3);
  a.merge(b.export());
  assert.equal(a.state.count, 3, "imported ops invalidate the cache");
  assert.equal(seen.at(-1)[0], "import");
});

test("write cost does not grow with the history when nobody subscribes", () => {
  // Regression: every write used to materialize the full state for change
  // notifications, even without listeners — quadratic in the history length.
  const schema = defineSchema({ players: map(object({ x: register(0), y: register(0) })) });
  const doc = createCrdtDocument({ id: "game", actorId: "a", schema });
  const batch = (n, offset) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i += 1) doc.set(["players", i % 2 ? "p1" : "p2", "x"], offset + i);
    return performance.now() - t0;
  };
  batch(500, 0); // warm up the JIT
  const early = batch(2_000, 1_000);
  batch(18_000, 10_000); // grow the history to ~20k ops
  const late = batch(2_000, 100_000);
  assert.equal(doc.state.players.p1.x, 101_999);
  assert.ok(late < early * 4, `2k writes: ${early.toFixed(1)} ms early vs ${late.toFixed(1)} ms at 20k ops`);
});
