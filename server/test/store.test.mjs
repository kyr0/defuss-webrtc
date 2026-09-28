import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomError, RoomStore } from "../dist/store.js";

let clock = 1_000_000;
const store = (options = {}) => new RoomStore({ now: () => clock, ...options });

const offerBundle = (peerId, sessionId) => ({ kind: "offer", sessionId, peerId, description: { type: "offer", sdp: "x" } });
const answerBundle = (peerId, sessionId) => ({ kind: "answer", sessionId, peerId, replyTo: sessionId, description: { type: "answer", sdp: "x" } });

function createLobby() {
  const s = store();
  s.createRoom("lobby", { peerId: "alice", nickname: "Alice" });
  return s;
}

test("create room: creator becomes moderator, room appears in list", () => {
  const s = createLobby();
  assert.deepEqual(s.listRooms().map((r) => ({ ...r, createdAt: 0 })), [
    { name: "lobby", memberCount: 1, createdAt: 0 },
  ]);
  const state = s.getState("lobby");
  assert.equal(state.members.length, 1);
  assert.equal(state.members[0].role, "moderator");
  assert.equal(state.members[0].nickname, "Alice");
});

test("create room: duplicate name conflicts, bad names rejected", () => {
  const s = createLobby();
  assert.throws(() => s.createRoom("lobby", { peerId: "bob", nickname: "Bob" }), (e) => e instanceof RoomError && e.status === 409);
  assert.throws(() => s.createRoom("no spaces!", { peerId: "bob", nickname: "Bob" }), (e) => e instanceof RoomError && e.status === 400);
});

test("join: stores offers addressed to existing members", () => {
  const s = createLobby();
  const state = s.joinRoom("lobby", { peerId: "bob", nickname: "Bob", offers: [{ to: "alice", bundle: offerBundle("bob", "s1") }] });
  assert.equal(state.members.length, 2);
  assert.equal(state.members[1].role, "member");
  assert.equal(state.offers.length, 1);
  assert.equal(state.offers[0].from, "bob");
  assert.equal(state.offers[0].to, "alice");
  assert.equal(state.offers[0].sessionId, "s1");
});

test("join: unknown room, duplicate peer, bad offer targets", () => {
  const s = createLobby();
  assert.throws(() => s.joinRoom("nope", { peerId: "bob", nickname: "Bob", offers: [] }), (e) => e.status === 404);
  assert.throws(() => s.joinRoom("lobby", { peerId: "alice", nickname: "A2", offers: [] }), (e) => e.status === 409);
  assert.throws(
    () => s.joinRoom("lobby", { peerId: "bob", nickname: "Bob", offers: [{ to: "ghost", bundle: offerBundle("bob", "s1") }] }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => s.joinRoom("lobby", { peerId: "bob", nickname: "Bob", offers: [{ to: "bob", bundle: offerBundle("bob", "s1") }] }),
    (e) => e.status === 400,
  );
  // failed joins must not leave the member behind
  assert.equal(s.getState("lobby").members.length, 1);
});

test("answers: consume the offer, are idempotent, must correspond", () => {
  const s = createLobby();
  s.joinRoom("lobby", { peerId: "bob", nickname: "Bob", offers: [{ to: "alice", bundle: offerBundle("bob", "s1") }] });

  assert.throws(
    () => s.addAnswer("lobby", { from: "alice", to: "bob", sessionId: "s1", bundle: answerBundle("alice", "wrong") }),
    (e) => e.status === 400,
  );

  s.addAnswer("lobby", { from: "alice", to: "bob", sessionId: "s1", bundle: answerBundle("alice", "s1") });
  let state = s.getState("lobby");
  assert.equal(state.offers.length, 0, "consumed offer is deleted");
  assert.equal(state.answers.length, 1);
  assert.equal(state.answers[0].to, "bob");

  s.addAnswer("lobby", { from: "alice", to: "bob", sessionId: "s1", bundle: answerBundle("alice", "s1") });
  state = s.getState("lobby");
  assert.equal(state.answers.length, 1, "duplicate answer is a no-op");

  assert.throws(
    () => s.addAnswer("lobby", { from: "alice", to: "bob", sessionId: "unknown", bundle: answerBundle("alice", "unknown") }),
    (e) => e.status === 404,
  );
});

test("late offers: members can offer after joining (mesh repair)", () => {
  const s = createLobby();
  s.joinRoom("lobby", { peerId: "bob", nickname: "Bob", offers: [] });
  s.addOffer("lobby", { from: "bob", to: "alice", bundle: offerBundle("bob", "s2") });
  assert.equal(s.getState("lobby").offers.length, 1);
  assert.throws(
    () => s.addOffer("lobby", { from: "bob", to: "alice", bundle: offerBundle("bob", "s2") }),
    (e) => e.status === 409,
  );
  assert.throws(
    () => s.addOffer("lobby", { from: "bob", to: "ghost", bundle: offerBundle("bob", "s3") }),
    (e) => e.status === 404,
  );
});

test("leave: signals of the leaving peer are removed, room deleted when empty", () => {
  const s = createLobby();
  s.joinRoom("lobby", { peerId: "bob", nickname: "Bob", offers: [{ to: "alice", bundle: offerBundle("bob", "s1") }] });
  s.leave("lobby", { peerId: "bob" });
  const state = s.getState("lobby");
  assert.equal(state.members.length, 1);
  assert.equal(state.offers.length, 0);

  s.leave("lobby", { peerId: "alice" });
  assert.equal(s.listRooms().length, 0, "empty room is deleted");
  assert.throws(() => s.getState("lobby"), (e) => e.status === 404);
});

test("moderator handover: oldest remaining member is promoted", () => {
  const s = store();
  s.createRoom("lobby", { peerId: "alice", nickname: "Alice" });
  clock += 1;
  s.joinRoom("lobby", { peerId: "bob", nickname: "Bob", offers: [{ to: "alice", bundle: offerBundle("bob", "s1") }] });
  clock += 1;
  s.joinRoom("lobby", { peerId: "carol", nickname: "Carol", offers: [] });
  s.leave("lobby", { peerId: "alice" });
  const state = s.getState("lobby");
  assert.equal(state.members.find((m) => m.peerId === "bob").role, "moderator");
  assert.equal(state.members.find((m) => m.peerId === "carol").role, "member");
});

test("sweep: timed-out members are dropped, stale signals collected", () => {
  const s = store({ memberTtlMs: 90_000, signalTtlMs: 120_000 });
  s.createRoom("lobby", { peerId: "alice", nickname: "Alice" });
  clock += 1;
  s.joinRoom("lobby", { peerId: "bob", nickname: "Bob", offers: [{ to: "alice", bundle: offerBundle("bob", "s1") }] });

  clock += 50_000;
  s.getState("lobby", "alice"); // alice heartbeat, bob goes silent
  clock += 50_000; // bob last seen 100 s ago, alice 50 s ago
  s.sweep();
  let state = s.getState("lobby");
  assert.deepEqual(state.members.map((m) => m.peerId), ["alice"]);
  assert.equal(state.offers.length, 0, "offers involving the dropped member are removed");

  clock += 200_000; // nobody heartbeats -> member TTL, room deleted
  s.sweep();
  assert.equal(s.listRooms().length, 0);

  // stale answers are collected even while members stay alive
  s.createRoom("r2", { peerId: "a", nickname: "A" });
  s.joinRoom("r2", { peerId: "b", nickname: "B", offers: [{ to: "a", bundle: offerBundle("b", "x") }] });
  s.addAnswer("r2", { from: "a", to: "b", sessionId: "x", bundle: answerBundle("a", "x") });
  clock += 130_000;
  s.getState("r2", "a"); // both members heartbeat
  s.getState("r2", "b");
  s.sweep();
  state = s.getState("r2");
  assert.equal(state.answers.length, 0);
  assert.equal(state.members.length, 2, "TTL only removes signals, members remain");
});
