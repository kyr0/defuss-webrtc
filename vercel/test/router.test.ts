import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler } from "../src/router.js";
import { RoomService } from "../src/service.js";
import { MemoryBackend } from "./memory-backend.js";

function setup() {
  const service = new RoomService(new MemoryBackend(), { now: () => 1_000 });
  return createHandler(service);
}

test("Vercel rewrite path is routed and CORS is present", async () => {
  const handler = setup();
  const response = await handler(
    new Request("https://example.test/api/index?__path=/v1/rooms/lobby", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peerId: "alice", nickname: "Alice" }),
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const body = (await response.json()) as { name: string };
  assert.equal(body.name, "lobby");
});

test("malformed JSON and oversized bodies use protocol errors", async () => {
  const handler = setup();
  let response = await handler(
    new Request("https://example.test/api/index?__path=/v1/rooms/lobby", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, "BAD_REQUEST");

  response = await handler(
    new Request("https://example.test/api/index?__path=/v1/rooms/lobby", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(256 * 1024 + 1) },
      body: "{}",
    }),
  );
  assert.equal(response.status, 413);
});

test("OPTIONS is a 204 preflight", async () => {
  const handler = setup();
  const response = await handler(new Request("https://example.test/api/index?__path=/v1/rooms", { method: "OPTIONS" }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
});

const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`https://example.test/api/index?__path=${path}`, init);
const code = async (response: Response) => ((await response.json()) as { error: string }).error;

test("server password: required on every /v1 route before parsing, percent-encoded header", async () => {
  const handler = createHandler(new RoomService(new MemoryBackend(), { now: () => 1_000 }), { serverPassword: "sërver" });
  let response = await handler(req("/v1/rooms"));
  assert.equal(response.status, 401);
  assert.equal(await code(response), "BAD_SERVER_PASSWORD");

  response = await handler(req("/v1/rooms", { headers: { "x-server-password": "wrong" } }));
  assert.equal(response.status, 401);

  // Malformed body and unknown routes are not observable without the password.
  response = await handler(req("/v1/rooms/lobby", { method: "POST", body: "{" }));
  assert.equal(await code(response), "BAD_SERVER_PASSWORD");
  response = await handler(req("/v1/nope"));
  assert.equal(await code(response), "BAD_SERVER_PASSWORD");

  // Preflight stays open and allows both password headers.
  response = await handler(req("/v1/rooms", { method: "OPTIONS" }));
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /x-server-password.*x-room-password/);

  response = await handler(req("/v1/rooms", { headers: { "x-server-password": encodeURIComponent("sërver") } }));
  assert.equal(response.status, 200);
});

test("room password travels in X-Room-Password for room routes", async () => {
  const handler = setup();
  const json = { "content-type": "application/json" };
  let response = await handler(req("/v1/rooms/secret", {
    method: "POST", headers: json, body: JSON.stringify({ peerId: "alice", nickname: "Alice", password: "pä ss" }),
  }));
  assert.equal(response.status, 201);
  assert.equal(((await response.json()) as { protected: boolean }).protected, true);

  response = await handler(req("/v1/rooms/secret/members"));
  assert.equal(response.status, 401);
  assert.equal(await code(response), "BAD_ROOM_PASSWORD");

  response = await handler(req("/v1/rooms/secret/members", { headers: { "x-room-password": encodeURIComponent("pä ss") } }));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes("salt") && !body.includes("hash"), "hash never leaves the server");

  // Unknown room action is a route 404, not a room/auth error.
  response = await handler(req("/v1/rooms/secret/bogus", { method: "POST", headers: json, body: "{}" }));
  assert.equal(await code(response), "NOT_FOUND");
});
