import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomError } from "../src/errors.ts";
import { RoomService } from "../src/service.ts";
import { MemoryBackend } from "./memory-backend.ts";

let clock = 1_000_000;
const offer = (peerId: string, sessionId: string) => ({ kind: "offer", peerId, sessionId });
const answer = (peerId: string, sessionId: string) => ({ kind: "answer", peerId, sessionId });

function setup() {
  clock = 1_000_000;
  const backend = new MemoryBackend();
  const service = new RoomService(backend, { now: () => clock });
  return { backend, service };
}

test("create/join/answer/leave follows protocol", async () => {
  const { service } = setup();
  let state = await service.createRoom("lobby", { peerId: "alice", nickname: "Alice" });
  assert.equal(state.members[0]?.role, "moderator");

  clock += 1;
  state = await service.joinRoom("lobby", {
    peerId: "bob",
    nickname: "Bob",
    offers: [{ to: "alice", bundle: offer("bob", "s1") }],
  });
  assert.equal(state.offers.length, 1);

  await service.addAnswer("lobby", {
    from: "alice",
    to: "bob",
    sessionId: "s1",
    bundle: answer("alice", "s1"),
  });
  state = await service.getState("lobby");
  assert.equal(state.offers.length, 0);
  assert.equal(state.answers.length, 1);

  await service.leave("lobby", { peerId: "alice" });
  state = await service.getState("lobby");
  assert.equal(state.members[0]?.peerId, "bob");
  assert.equal(state.members[0]?.role, "moderator");
});

test("join validation is atomic, including duplicate session ids", async () => {
  const { service } = setup();
  await service.createRoom("lobby", { peerId: "alice", nickname: "Alice" });
  await assert.rejects(
    service.joinRoom("lobby", {
      peerId: "bob",
      nickname: "Bob",
      offers: [
        { to: "alice", bundle: offer("bob", "dup") },
        { to: "alice", bundle: offer("bob", "dup") },
      ],
    }),
    (error: unknown) => error instanceof RoomError && error.code === "BAD_OFFERS",
  );
  const state = await service.getState("lobby");
  assert.deepEqual(state.members.map((member) => member.peerId), ["alice"]);
  assert.equal(state.offers.length, 0);
});

test("concurrent joins do not lose updates", async () => {
  const { service } = setup();
  await service.createRoom("lobby", { peerId: "alice", nickname: "Alice" });
  clock += 1;
  await Promise.all([
    service.joinRoom("lobby", { peerId: "bob", nickname: "Bob", offers: [] }),
    service.joinRoom("lobby", { peerId: "carol", nickname: "Carol", offers: [] }),
  ]);
  const state = await service.getState("lobby");
  assert.deepEqual(new Set(state.members.map((member) => member.peerId)), new Set(["alice", "bob", "carol"]));
  assert.equal(new Set(state.members.map((member) => member.joinedAt)).size, 3, "joinedAt remains a total order");
});

test("lazy sweep enforces member and signal TTLs", async () => {
  const { service } = setup();
  await service.createRoom("lobby", { peerId: "alice", nickname: "Alice" });
  clock += 1;
  await service.joinRoom("lobby", {
    peerId: "bob",
    nickname: "Bob",
    offers: [{ to: "alice", bundle: offer("bob", "s1") }],
  });
  clock += 50_000;
  await service.getState("lobby", "alice");
  clock += 50_000;
  const state = await service.getState("lobby");
  assert.deepEqual(state.members.map((member) => member.peerId), ["alice"]);
  assert.equal(state.offers.length, 0);

  clock += 100_000;
  await assert.rejects(service.getState("lobby"), (error: unknown) => error instanceof RoomError && error.code === "ROOM_NOT_FOUND");
  assert.deepEqual(await service.listRooms(), []);
});

test("concurrent duplicate answers consume one offer exactly once", async () => {
  const { service } = setup();
  await service.createRoom("lobby", { peerId: "alice", nickname: "Alice" });
  clock += 1;
  await service.joinRoom("lobby", {
    peerId: "bob",
    nickname: "Bob",
    offers: [{ to: "alice", bundle: offer("bob", "s1") }],
  });
  const payload = { from: "alice", to: "bob", sessionId: "s1", bundle: answer("alice", "s1") };
  await Promise.all([service.addAnswer("lobby", payload), service.addAnswer("lobby", payload)]);
  const state = await service.getState("lobby");
  assert.equal(state.offers.length, 0);
  assert.equal(state.answers.length, 1);
});

test("revision CAS rejects stale room incarnation (ABA)", async () => {
  const { backend, service } = setup();
  await service.createRoom("lobby", { peerId: "alice", nickname: "Alice" });
  const stale = await backend.get("lobby");
  assert.ok(stale);
  await service.leave("lobby", { peerId: "alice" });
  clock += 1;
  await service.createRoom("lobby", { peerId: "bob", nickname: "Bob" });
  const accepted = await backend.compareAndSwap("lobby", stale.revision, stale);
  assert.equal(accepted, false);
  const current = await service.getState("lobby");
  assert.deepEqual(current.members.map((member) => member.peerId), ["bob"]);
});

test("room password: optional, gates every room operation, never exposed", async () => {
  const { backend, service } = setup();
  const open = await service.createRoom("open", { peerId: "alice", nickname: "Alice" });
  const secret = await service.createRoom("secret", { peerId: "carol", nickname: "Carol", password: "hunter2" });
  assert.equal(open.protected, false);
  assert.equal(secret.protected, true);
  assert.ok(!("password" in secret), "hash must not be returned");
  assert.deepEqual((await service.listRooms()).map((r) => [r.name, r.protected]), [["open", false], ["secret", true]]);
  assert.ok(backend.rooms.get("secret")!.room.password?.hash, "hash is persisted");
  assert.ok(!JSON.stringify(backend.rooms.get("secret")).includes("hunter2"), "no plaintext persisted");

  // Open rooms accept any or no password.
  await service.getState("open");
  await service.getState("open", undefined, "whatever");

  const denied = (e: unknown) => e instanceof RoomError && e.status === 401 && e.code === "BAD_ROOM_PASSWORD";
  const join = { peerId: "dave", nickname: "Dave", offers: [] };
  await assert.rejects(service.getState("secret"), denied);
  await assert.rejects(service.getState("secret", undefined, "nope"), denied);
  await assert.rejects(service.joinRoom("secret", join), denied);
  await assert.rejects(service.addOffer("secret", {}), denied);
  await assert.rejects(service.addAnswer("secret", {}), denied);
  await assert.rejects(service.leave("secret", { peerId: "carol" }), denied);

  // Precedence: unknown room beats password, password beats body validation.
  await assert.rejects(service.getState("missing", undefined, "x"), (e) => e instanceof RoomError && e.status === 404);
  await assert.rejects(service.joinRoom("secret", {}), denied);

  const joined = await service.joinRoom("secret", join, "hunter2");
  assert.equal(joined.members.length, 2);
  assert.ok(!("password" in (await service.getState("secret", "dave", "hunter2"))));
  await service.leave("secret", { peerId: "dave" }, "hunter2");
});

test("room password: validation, empty means open, legacy records read as open", async () => {
  const { backend, service } = setup();
  assert.equal((await service.createRoom("a", { peerId: "alice", nickname: "Alice", password: "" })).protected, false);
  await assert.rejects(service.createRoom("b", { peerId: "bob", nickname: "Bob", password: 42 }), (e) => e instanceof RoomError && e.code === "BAD_PASSWORD");
  await assert.rejects(service.createRoom("b", { peerId: "bob", nickname: "Bob", password: "x".repeat(257) }), (e) => e instanceof RoomError && e.code === "BAD_PASSWORD");
  assert.equal(backend.rooms.has("b"), false);

  // A record persisted before password support has no `password` field.
  await backend.compareAndSwap("legacy", null, {
    revision: "r0",
    room: { name: "legacy", createdAt: clock, members: [{ peerId: "zed", nickname: "Zed", role: "moderator", joinedAt: clock, lastSeen: clock }], offers: [], answers: [] },
  });
  assert.equal((await service.getState("legacy")).protected, false);
  assert.equal((await service.listRooms()).find((r) => r.name === "legacy")?.protected, false);
});

test("room password is checked against the incarnation being mutated", async () => {
  const { backend, service } = setup();
  await service.createRoom("r", { peerId: "alice", nickname: "Alice", password: "old" });
  // Room is deleted and recreated with a different password under the same name.
  await service.leave("r", { peerId: "alice" }, "old");
  await service.createRoom("r", { peerId: "mallory", nickname: "Mallory", password: "new" });
  await assert.rejects(service.joinRoom("r", { peerId: "bob", nickname: "Bob", offers: [] }, "old"), (e) => e instanceof RoomError && e.code === "BAD_ROOM_PASSWORD");
  assert.equal(backend.rooms.get("r")!.room.members.length, 1);
});
