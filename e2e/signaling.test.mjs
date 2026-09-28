// End-to-end conformance tests for the room signaling protocol (server/PROTOCOL.md).
//
// One suite, any target — so passing on both proves the implementations conform:
//
//   npm run test:e2e                                          local: builds + spawns server/dist
//   E2E_BASE_URL=https://defuss-webrtc.vercel.app npm run test:e2e:remote   any deployment
//
// Environment:
//   E2E_BASE_URL          target origin; unset = spawn the local Express server
//   E2E_SERVER_PASSWORD   the target's server password, if it has one. Locally it is the
//                         password the spawned server gets (default: a non-ASCII test
//                         password; set it to "" to spawn an open server)
//   E2E_VERCEL_BYPASS     "Protection Bypass for Automation" secret for Vercel
//                         deployments behind Deployment Protection
//
// Every run uses unique room names and leaves its rooms at the end, so it is safe to
// run against a shared deployment. Real WebRTC is out of scope: the server treats
// signal bundles as opaque, so synthetic bundles exercise the full protocol.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const REMOTE = process.env.E2E_BASE_URL?.replace(/\/+$/, "");
const BYPASS = process.env.E2E_VERCEL_BYPASS;
const SERVER_PASSWORD = process.env.E2E_SERVER_PASSWORD ?? (REMOTE ? "" : "e2e-sërver-pässword");
const RUN = Math.random().toString(36).slice(2, 8);
const TIMEOUT_MS = 20_000;

let base;
let child;
const cleanup = []; // [room, roomPassword, peerId] still to leave

// ---------------------------------------------------------------------------
// Target setup
// ---------------------------------------------------------------------------

async function freePort() {
  const server = createServer().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startLocalServer() {
  const entry = fileURLToPath(new URL("../server/dist/index.js", import.meta.url));
  if (!existsSync(entry)) throw new Error(`${entry} not found — run "npm --prefix server run build" first`);
  const port = await freePort();
  child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), SERVER_PASSWORD },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`${url}/v1/rooms`);
      return url;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Local server did not start");
}

before(async () => {
  base = REMOTE ?? (await startLocalServer());
  // Fail fast, with a useful message, when a platform layer answers instead of the server.
  const response = await call("GET", "/v1/rooms");
  const type = response.headers.get("content-type") ?? "";
  if ([301, 302, 307, 308].includes(response.status) || !type.includes("application/json")) {
    const sso = /_vercel_sso|vercel\.com\/sso/.test(`${response.headers.get("set-cookie")} ${response.headers.get("location")}`);
    throw new Error(
      `${base}/v1/rooms answered ${response.status} ${type || "(no content-type)"} instead of JSON.` +
        (sso
          ? " This deployment is behind Vercel Deployment Protection: set E2E_VERCEL_BYPASS to the project's" +
            " \"Protection Bypass for Automation\" secret (Project Settings → Deployment Protection)."
          : ""),
    );
  }
  if (response.status === 401 && !SERVER_PASSWORD) {
    throw new Error(`${base} requires a server password (${response.json?.message}) — set E2E_SERVER_PASSWORD`);
  }
  console.log(`# target: ${base} (${REMOTE ? "remote" : "local Express"}), server password: ${SERVER_PASSWORD ? "yes" : "no"}, run: ${RUN}`);
});

after(async () => {
  for (const [room, roomPassword, peerId] of cleanup.reverse()) {
    await call("POST", `/v1/rooms/${room}/leave`, { body: { peerId }, roomPassword }).catch(() => {});
  }
  child?.kill();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sends a request. The server password is attached automatically unless
 * `serverPassword` is given (null = send none). Passwords are percent-encoded
 * like the protocol requires; `rawHeaders` bypasses that for malformed cases.
 */
async function call(method, path, { body, roomPassword, serverPassword, rawHeaders = {} } = {}) {
  const headers = {};
  if (BYPASS) headers["x-vercel-protection-bypass"] = BYPASS;
  const server = serverPassword === undefined ? SERVER_PASSWORD : serverPassword;
  if (server) headers["x-server-password"] = encodeURIComponent(server);
  if (roomPassword) headers["x-room-password"] = encodeURIComponent(roomPassword);
  if (body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, rawHeaders);
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** Asserts a protocol error: exact status, code and message (both servers emit identical wording). */
function assertError(response, status, error, message) {
  assert.deepEqual(
    { status: response.status, error: response.json?.error, message: response.json?.message },
    { status, error, message },
    `unexpected response: ${response.status} ${response.text.slice(0, 300)}`,
  );
}

function assertOk(response, status = 200) {
  assert.equal(response.status, status, `expected ${status}, got ${response.status} ${response.text.slice(0, 300)}`);
  return response.json;
}

const room = (label) => `e2e-${RUN}-${label}`;
const offer = (peerId, sessionId) => ({ kind: "offer", peerId, sessionId, description: { type: "offer", sdp: "v=0" } });
const answer = (peerId, sessionId) => ({ kind: "answer", peerId, sessionId, replyTo: sessionId, description: { type: "answer", sdp: "v=0" } });

async function createRoom(name, peerId, { password, nickname = peerId } = {}) {
  const state = assertOk(await call("POST", `/v1/rooms/${name}`, { body: { peerId, nickname, password } }), 201);
  cleanup.push([name, password, peerId]);
  return state;
}

async function joinRoom(name, peerId, offers, { password, nickname = peerId } = {}) {
  const state = assertOk(await call("POST", `/v1/rooms/${name}/join`, { body: { peerId, nickname, offers }, roomPassword: password }));
  cleanup.push([name, password, peerId]);
  return state;
}

const names = (state) => state.members.map((member) => member.peerId);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transport", () => {
  test("CORS preflight allows any origin and both password headers", async () => {
    const response = await call("OPTIONS", "/v1/rooms", { serverPassword: null });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
    const allowed = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const header of ["content-type", "x-server-password", "x-room-password"]) assert.ok(allowed.includes(header), allowed);
  });

  test("JSON responses carry CORS headers", async () => {
    const response = await call("GET", "/v1/rooms");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  });

  test("unknown routes and wrong methods are NOT_FOUND", async () => {
    assertError(await call("GET", "/v1/nope"), 404, "NOT_FOUND", "Unknown route: GET /v1/nope");
    const name = room("routes");
    await createRoom(name, "alice");
    assertError(await call("POST", `/v1/rooms/${name}/bogus`, { body: {} }), 404, "NOT_FOUND", `Unknown route: POST /v1/rooms/${name}/bogus`);
    assertError(await call("POST", `/v1/rooms/${name}/members`, { body: {} }), 404, "NOT_FOUND", `Unknown route: POST /v1/rooms/${name}/members`);
  });

  test("malformed JSON is BAD_REQUEST", async () => {
    assertError(await call("POST", `/v1/rooms/${room("x")}`, { body: "{" }), 400, "BAD_REQUEST", "Malformed JSON body");
  });

  test("bodies over 256 KB are rejected with 413", async () => {
    const big = JSON.stringify({ peerId: "a", nickname: "A", pad: "x".repeat(270_000) });
    assertError(await call("POST", `/v1/rooms/${room("x")}`, { body: big }), 413, "BAD_REQUEST", "Request body exceeds 256 KB");
  });

  test("room names are validated, including their URL encoding", async (t) => {
    const message = "Room name must match ^[a-zA-Z0-9_-]{1,64}$";
    assertError(await call("POST", "/v1/rooms/no%20spaces", { body: { peerId: "a", nickname: "A" } }), 400, "BAD_ROOM_NAME", message);
    assertError(await call("GET", `/v1/rooms/${"x".repeat(65)}/members`), 400, "BAD_ROOM_NAME", message);

    const malformed = await call("GET", "/v1/rooms/%E0%A4%A/members");
    if (malformed.status === 400 && malformed.json === undefined) {
      // Some edges reject malformed percent-encoding before the app runs (Vercel answers a
      // plain-text "400 Bad Request", or an HTTP/2 PROTOCOL_ERROR). Same status, no envelope.
      t.diagnostic(`platform rejected the malformed URL itself: ${JSON.stringify(malformed.text.slice(0, 60))}`);
      return;
    }
    assertError(malformed, 400, "BAD_ROOM_NAME", "Room name is not valid URL encoding");
  });
});

describe("server password", { skip: !SERVER_PASSWORD && "target has no server password" }, () => {
  test("missing, wrong or malformed passwords are rejected", async () => {
    assertError(await call("GET", "/v1/rooms", { serverPassword: null }), 401, "BAD_SERVER_PASSWORD", "This server requires a password");
    assertError(await call("GET", "/v1/rooms", { serverPassword: "wrong" }), 401, "BAD_SERVER_PASSWORD", "Wrong server password");
    assertError(
      await call("GET", "/v1/rooms", { serverPassword: null, rawHeaders: { "x-server-password": "%E0%A4%A" } }),
      401,
      "BAD_SERVER_PASSWORD",
      "This server requires a password",
    );
  });

  test("it is checked before routing and body parsing", async () => {
    const denied = [401, "BAD_SERVER_PASSWORD", "This server requires a password"];
    assertError(await call("GET", "/v1/nope", { serverPassword: null }), ...denied);
    assertError(await call("POST", `/v1/rooms/${room("x")}`, { body: "{", serverPassword: null }), ...denied);
    assertError(await call("GET", "/v1/rooms/missing/members", { serverPassword: null }), ...denied);
  });

  test("the correct password is accepted (percent-encoded UTF-8)", async () => {
    assert.ok(Array.isArray(assertOk(await call("GET", "/v1/rooms"))));
  });
});

describe("open server", { skip: Boolean(SERVER_PASSWORD) && "target has a server password" }, () => {
  test("requests without a server password are accepted", async () => {
    assertOk(await call("GET", "/v1/rooms", { serverPassword: null }));
  });
});

describe("room lifecycle", () => {
  const name = room("life");

  test("create: creator becomes moderator, room is listed as open", async () => {
    const state = await createRoom(name, "alice", { nickname: "  Alice  " });
    assert.equal(state.name, name);
    assert.equal(state.protected, false);
    assert.deepEqual(state.members.map(({ peerId, nickname, role }) => ({ peerId, nickname, role })), [
      { peerId: "alice", nickname: "Alice", role: "moderator" },
    ]);
    assert.deepEqual([state.offers, state.answers], [[], []]);
    const listed = assertOk(await call("GET", "/v1/rooms")).find((entry) => entry.name === name);
    assert.deepEqual({ ...listed, createdAt: 0 }, { name, memberCount: 1, createdAt: 0, protected: false });
    assertError(await call("POST", `/v1/rooms/${name}`, { body: { peerId: "zed", nickname: "Z" } }), 409, "ROOM_EXISTS", `Room "${name}" already exists`);
  });

  test("join: stores one offer per member, members ordered by joinedAt", async () => {
    const state = await joinRoom(name, "bob", [{ to: "alice", bundle: offer("bob", `${RUN}-s1`) }]);
    assert.deepEqual(names(state), ["alice", "bob"]);
    assert.equal(state.members[1].role, "member");
    assert.ok(state.members[1].joinedAt > state.members[0].joinedAt);
    assert.deepEqual(state.offers.map(({ from, to, sessionId }) => ({ from, to, sessionId })), [{ from: "bob", to: "alice", sessionId: `${RUN}-s1` }]);
    assert.deepEqual(state.offers[0].bundle, offer("bob", `${RUN}-s1`), "bundle is passed through opaquely");
    assertError(await call("POST", `/v1/rooms/${name}/join`, { body: { peerId: "bob", nickname: "Bob", offers: [] } }), 409, "ALREADY_JOINED", `Peer bob is already in room "${name}"`);
  });

  test("poll with ?peerId= refreshes the member's lastSeen (heartbeat)", async () => {
    const before = assertOk(await call("GET", `/v1/rooms/${name}/members`)).members.find((member) => member.peerId === "alice").lastSeen;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = assertOk(await call("GET", `/v1/rooms/${name}/members?peerId=alice`)).members.find((member) => member.peerId === "alice").lastSeen;
    assert.ok(after > before, `lastSeen ${after} should be > ${before}`);
  });

  test("answers: consume the offer, are idempotent, must correspond", async () => {
    const path = `/v1/rooms/${name}/answers`;
    const s1 = `${RUN}-s1`;
    assertError(await call("POST", path, { body: { from: "alice", to: "bob", sessionId: s1, bundle: answer("alice", "other") } }), 400, "BAD_BUNDLE", "answer bundle sessionId must match sessionId");
    assertError(await call("POST", path, { body: { from: "alice", to: "bob", sessionId: s1, bundle: answer("bob", s1) } }), 400, "BAD_BUNDLE", "answer bundle peerId must match from");
    assertError(await call("POST", path, { body: { from: "alice", to: "bob", sessionId: "none", bundle: answer("alice", "none") } }), 404, "OFFER_NOT_FOUND", "No pending offer with sessionId none");
    assertError(await call("POST", path, { body: { from: "bob", to: "alice", sessionId: s1, bundle: answer("bob", s1) } }), 400, "ANSWER_MISMATCH", "answer does not correspond to the stored offer");
    assertError(await call("POST", path, { body: { from: "ghost", to: "bob", sessionId: s1, bundle: answer("ghost", s1) } }), 404, "NOT_A_MEMBER", `Peer ghost is not a member of room "${name}"`);

    const ok = { from: "alice", to: "bob", sessionId: s1, bundle: answer("alice", s1) };
    assert.deepEqual(assertOk(await call("POST", path, { body: ok }), 201), { ok: true });
    assert.deepEqual(assertOk(await call("POST", path, { body: ok }), 201), { ok: true }, "duplicate answer is a no-op");

    const state = assertOk(await call("GET", `/v1/rooms/${name}/members`));
    assert.deepEqual(state.offers, []);
    assert.deepEqual(state.answers.map(({ from, to, sessionId }) => ({ from, to, sessionId })), [{ from: "alice", to: "bob", sessionId: s1 }]);
  });

  test("late offers (mesh repair)", async () => {
    const path = `/v1/rooms/${name}/offers`;
    const s2 = `${RUN}-s2`;
    assertError(await call("POST", path, { body: { from: "alice", to: "alice", bundle: offer("alice", s2) } }), 400, "BAD_OFFER", "cannot address an offer to yourself");
    assertError(await call("POST", path, { body: { from: "alice", to: "ghost", bundle: offer("alice", s2) } }), 404, "NOT_A_MEMBER", `Peer ghost is not a member of room "${name}"`);
    assertError(await call("POST", path, { body: { from: "alice", to: "bob", bundle: offer("bob", s2) } }), 400, "BAD_BUNDLE", "offer bundle peerId must match from");
    assert.deepEqual(assertOk(await call("POST", path, { body: { from: "alice", to: "bob", bundle: offer("alice", s2) } }), 201), { ok: true });
    assertError(await call("POST", path, { body: { from: "alice", to: "bob", bundle: offer("alice", s2) } }), 409, "OFFER_EXISTS", `An offer with sessionId ${s2} is already stored`);
  });

  test("leave: moderator hands over to the oldest member, empty room is deleted", async () => {
    const path = `/v1/rooms/${name}/leave`;
    assertError(await call("POST", path, { body: { peerId: "ghost" } }), 404, "NOT_A_MEMBER", `Peer ghost is not a member of room "${name}"`);
    await joinRoom(name, "carol", [{ to: "alice", bundle: offer("carol", `${RUN}-c1`) }, { to: "bob", bundle: offer("carol", `${RUN}-c2`) }]);

    assert.deepEqual(assertOk(await call("POST", path, { body: { peerId: "alice" } })), { ok: true });
    let state = assertOk(await call("GET", `/v1/rooms/${name}/members`));
    assert.deepEqual(state.members.map(({ peerId, role }) => [peerId, role]), [["bob", "moderator"], ["carol", "member"]]);
    assert.ok(state.offers.every((entry) => entry.from !== "alice" && entry.to !== "alice"), "signals of the leaver are removed");
    assert.ok(state.answers.every((entry) => entry.from !== "alice" && entry.to !== "alice"));

    assertOk(await call("POST", path, { body: { peerId: "bob" } }));
    assertOk(await call("POST", path, { body: { peerId: "carol" } }));
    assertError(await call("GET", `/v1/rooms/${name}/members`), 404, "ROOM_NOT_FOUND", `Room "${name}" does not exist`);
    assert.ok(!assertOk(await call("GET", "/v1/rooms")).some((entry) => entry.name === name), "deleted room is unlisted");
  });
});

describe("consistency under concurrency", () => {
  test("concurrent joins and polls all see the room, and no join is lost", async () => {
    // Serverless targets spread concurrent requests over fresh instances; every one of
    // them must read the latest room state (no stale replica reads, no lost updates).
    for (let trial = 1; trial <= 3; trial += 1) {
      const name = room(`conc${trial}`);
      await createRoom(name, "alice");
      const joiners = ["bob", "carol", "dave"];
      const results = await Promise.all([
        ...joiners.map((peerId) => call("POST", `/v1/rooms/${name}/join`, { body: { peerId, nickname: peerId, offers: [] } })),
        ...Array.from({ length: 12 }, () => call("GET", `/v1/rooms/${name}/members?peerId=alice`)),
      ]);
      joiners.forEach((peerId) => cleanup.push([name, undefined, peerId]));
      const failures = results.filter((response) => response.status !== 200).map((response) => `${response.status} ${response.json?.message}`);
      assert.deepEqual(failures, [], `trial ${trial}: requests failed under concurrency`);
      const state = assertOk(await call("GET", `/v1/rooms/${name}/members`));
      // Concurrent joins land in any order; alice (the creator) stays first.
      assert.equal(names(state)[0], "alice");
      assert.deepEqual([...names(state)].sort(), ["alice", ...joiners], `trial ${trial}: a join was lost`);
    }
  });
});

describe("input validation", () => {
  const name = room("valid");

  test("create validates everything before creating the room", async () => {
    const create = (body) => call("POST", `/v1/rooms/${name}`, { body });
    assertError(await create({ peerId: "", nickname: "A" }), 400, "BAD_ID", "peerId must be a non-empty string of at most 256 chars");
    assertError(await create({ peerId: "x".repeat(257), nickname: "A" }), 400, "BAD_ID", "peerId must be a non-empty string of at most 256 chars");
    assertError(await create({ peerId: "a", nickname: "   " }), 400, "BAD_NICKNAME", "nickname must be a non-empty string of at most 64 chars");
    assertError(await create({ peerId: "a", nickname: "n".repeat(65) }), 400, "BAD_NICKNAME", "nickname must be a non-empty string of at most 64 chars");
    assertError(await create({ peerId: "a", nickname: "A", password: 42 }), 400, "BAD_PASSWORD", "password must be a string of at most 256 chars");
    assertError(await create({ peerId: "a", nickname: "A", password: "p".repeat(257) }), 400, "BAD_PASSWORD", "password must be a string of at most 256 chars");
    assertError(await call("GET", `/v1/rooms/${name}/members`), 404, "ROOM_NOT_FOUND", `Room "${name}" does not exist`);
  });

  test("join validates offers atomically — no half-joined members", async () => {
    await createRoom(name, "alice");
    await joinRoom(name, "bob", [{ to: "alice", bundle: offer("bob", `${RUN}-v1`) }]);
    const join = (offers, peerId = "carol") => call("POST", `/v1/rooms/${name}/join`, { body: { peerId, nickname: "Carol", offers } });

    assertError(await join(undefined), 400, "BAD_OFFERS", "offers must be an array");
    assertError(await join([{ to: "carol", bundle: offer("carol", `${RUN}-v2`) }]), 400, "BAD_OFFERS", "cannot address an offer to yourself");
    assertError(await join([{ to: "ghost", bundle: offer("carol", `${RUN}-v2`) }]), 400, "BAD_OFFERS", `offer target ghost is not a member of room "${name}"`);
    assertError(await join([{ to: "alice", bundle: [] }]), 400, "BAD_BUNDLE", "bundle must be an object");
    assertError(await join([{ to: "alice", bundle: answer("carol", `${RUN}-v2`) }]), 400, "BAD_BUNDLE", 'bundle.kind must be "offer"');
    assertError(await join([{ to: "alice", bundle: { kind: "offer", peerId: "carol" } }]), 400, "BAD_BUNDLE", "bundle.sessionId must be a non-empty string");
    assertError(await join([{ to: "alice", bundle: offer("eve", `${RUN}-v2`) }]), 400, "BAD_BUNDLE", "offer bundle peerId must match the joining peerId");
    // One valid offer followed by an invalid one must not store the valid one either.
    assertError(await join([{ to: "alice", bundle: offer("carol", `${RUN}-v2`) }, { to: "ghost", bundle: offer("carol", `${RUN}-v3`) }]), 400, "BAD_OFFERS", `offer target ghost is not a member of room "${name}"`);
    // Session ids must be unique: against stored offers, and within one request.
    assertError(await join([{ to: "alice", bundle: offer("carol", `${RUN}-v1`) }]), 400, "BAD_OFFERS", `duplicate offer sessionId ${RUN}-v1`);
    assertError(await join([{ to: "alice", bundle: offer("carol", `${RUN}-v4`) }, { to: "bob", bundle: offer("carol", `${RUN}-v4`) }]), 400, "BAD_OFFERS", `duplicate offer sessionId ${RUN}-v4`);

    const state = assertOk(await call("GET", `/v1/rooms/${name}/members`));
    assert.deepEqual(names(state), ["alice", "bob"], "no failed join left a member behind");
    assert.deepEqual(state.offers.map((entry) => entry.sessionId), [`${RUN}-v1`], "no failed join left an offer behind");
  });
});

describe("room password", () => {
  const secret = room("secret");
  const open = room("open");
  const password = "rööm pässword & more";

  test("create: protected rooms are flagged, the password never leaves the server", async () => {
    const state = await createRoom(secret, "alice", { password });
    assert.equal(state.protected, true);
    const listed = assertOk(await call("GET", "/v1/rooms")).find((entry) => entry.name === secret);
    assert.equal(listed.protected, true);
    for (const response of [JSON.stringify(state), JSON.stringify(listed)]) {
      assert.ok(!/password|salt|hash|rööm/.test(response), `leaked: ${response}`);
    }
  });

  test("an empty password creates an open room", async () => {
    assert.equal((await createRoom(open, "alice", { password: "" })).protected, false);
  });

  test("every room endpoint requires it", async () => {
    const missing = [401, "BAD_ROOM_PASSWORD", `Room "${secret}" requires a password`];
    const wrong = [401, "BAD_ROOM_PASSWORD", `Wrong password for room "${secret}"`];
    const requests = [
      ["GET", `/v1/rooms/${secret}/members`, undefined],
      ["POST", `/v1/rooms/${secret}/join`, { peerId: "bob", nickname: "Bob", offers: [] }],
      ["POST", `/v1/rooms/${secret}/offers`, { from: "alice", to: "bob", bundle: offer("alice", `${RUN}-p1`) }],
      ["POST", `/v1/rooms/${secret}/answers`, { from: "alice", to: "bob", sessionId: `${RUN}-p1`, bundle: answer("alice", `${RUN}-p1`) }],
      ["POST", `/v1/rooms/${secret}/leave`, { peerId: "alice" }],
    ];
    for (const [method, path, body] of requests) {
      assertError(await call(method, path, { body }), ...missing);
      assertError(await call(method, path, { body, roomPassword: "nope" }), ...wrong);
      assertError(await call(method, path, { body, rawHeaders: { "x-room-password": "%E0%A4%A" } }), ...missing);
    }
  });

  test("precedence: unknown room, then room password, then body validation", async () => {
    assertError(await call("GET", `/v1/rooms/${room("missing")}/members`, { roomPassword: "x" }), 404, "ROOM_NOT_FOUND", `Room "${room("missing")}" does not exist`);
    assertError(await call("POST", `/v1/rooms/${secret}/join`, { body: {} }), 401, "BAD_ROOM_PASSWORD", `Room "${secret}" requires a password`);
    assertError(await call("POST", `/v1/rooms/${secret}/join`, { body: {}, roomPassword: password }), 400, "BAD_ID", "peerId must be a non-empty string of at most 256 chars");
  });

  test("the correct password unlocks the full signaling flow", async () => {
    const state = await joinRoom(secret, "bob", [{ to: "alice", bundle: offer("bob", `${RUN}-p2`) }], { password });
    assert.deepEqual(names(state), ["alice", "bob"]);
    assert.equal(state.protected, true);
    assertOk(await call("POST", `/v1/rooms/${secret}/answers`, { roomPassword: password, body: { from: "alice", to: "bob", sessionId: `${RUN}-p2`, bundle: answer("alice", `${RUN}-p2`) } }), 201);
    assertOk(await call("POST", `/v1/rooms/${secret}/offers`, { roomPassword: password, body: { from: "bob", to: "alice", bundle: offer("bob", `${RUN}-p3`) } }), 201);
    const polled = assertOk(await call("GET", `/v1/rooms/${secret}/members?peerId=bob`, { roomPassword: password }));
    assert.deepEqual(polled.answers.map((entry) => entry.sessionId), [`${RUN}-p2`]);
    assert.deepEqual(polled.offers.map((entry) => entry.sessionId), [`${RUN}-p3`]);
    assert.ok(!/salt|hash|rööm/.test(JSON.stringify(polled)));
    assertOk(await call("POST", `/v1/rooms/${secret}/leave`, { roomPassword: password, body: { peerId: "bob" } }));
  });

  test("open rooms ignore the room password header", async () => {
    assertOk(await call("GET", `/v1/rooms/${open}/members`, { roomPassword: "anything" }));
    assertOk(await call("GET", `/v1/rooms/${open}/members`));
  });
});
