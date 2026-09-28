# defuss-webrtc room server

Minimal room-based signaling rendezvous server for
[`defuss-webrtc`](../README.md) peers. It brokers WebRTC offer/answer exchange
so every peer in a room ends up directly connected to every other peer (full
mesh). The server never sees application traffic — after signaling, everything
flows over P2P data channels.

State is in-memory and isolated in `src/store.ts` (`RoomStore`), so porting to
serverless functions only means swapping the store for a shared KV/Redis.

## Run

```bash
npm install
npm run dev      # tsx watch, http://localhost:8787 (PORT env to override)
npm test         # store unit tests
npm run build && npm start   # compiled variant
SERVER_PASSWORD=s3cret npm run dev   # optional: require a server password
```

## Passwords (optional)

- **Server password**: set `SERVER_PASSWORD`; every `/v1` request must then
  send it in the `X-Server-Password` header (else `401 BAD_SERVER_PASSWORD`).
- **Room password**: pass `password` when creating a room; every later request
  for that room must send it in `X-Room-Password` (else `401
  BAD_ROOM_PASSWORD`). The room list shows `protected: true` for such rooms.

Header values are `encodeURIComponent(password)`. Room passwords are stored as
salted HMACs only. Use TLS whenever passwords are in play.

> **`PROTOCOL.md` is the normative specification** of this API — exact data
> shapes, error codes, the mesh algorithm, presence/GC rules, and notes for
> reimplementing it as serverless functions. This README is the summary.

## Protocol

One WebRTC offer can be answered exactly once, so a mesh of N peers needs one
offer per peer pair. The rule: **the joiner offers to every existing member.**

1. Alice creates the room and is its moderator.
2. Bob fetches the members, creates one offer per member, and joins with them.
3. Alice polls, sees the offer addressed to her, posts an answer.
4. Bob's next poll sees the answer addressed to him; both data channels open.
5. Carol joins → offers to Alice and Bob → mesh complete.

If two peers join simultaneously and miss each other, the peer with the later
`joinedAt` heals the pairing by posting a late offer.

`GET .../members?peerId=<id>` doubles as a presence heartbeat. Members without
a heartbeat for 90 s are dropped (moderator role passes to the oldest remaining
member; an empty room is deleted). Offers/answers older than 120 s are
garbage-collected; an offer is deleted as soon as its answer arrives.

## API

Base: `/v1`. JSON bodies. Room names must match `^[a-zA-Z0-9_-]{1,64}$`.
Errors are `{ "error": "code", "message": "..." }` with a fitting 4xx status.

| Method & path | Body | Response | Notes |
| --- | --- | --- | --- |
| `GET /v1/rooms` | — | `[{ name, memberCount, createdAt, protected }]` | room list |
| `POST /v1/rooms/{name}` | `{ peerId, nickname, password? }` | `201 RoomState` | creates room, caller becomes moderator; `409` if it exists; `password` protects it |
| `POST /v1/rooms/{name}/join` | `{ peerId, nickname, offers: [{ to, bundle }] }` | `200 RoomState` | `404` no room, `409` already joined |
| `GET /v1/rooms/{name}/members?peerId=` | — | `RoomState` | members + offers + answers; clients filter by `to`; `?peerId=` heartbeat |
| `POST /v1/rooms/{name}/offers` | `{ from, to, bundle }` | `201` | late/mesh-repair offer |
| `POST /v1/rooms/{name}/answers` | `{ from, to, sessionId, bundle }` | `201` | consumes the stored offer; duplicate posts are a no-op |
| `POST /v1/rooms/{name}/leave` | `{ peerId }` | `200` | drops the member and all their signals |

Routes below `/v1/rooms/{name}/` require `X-Room-Password` for protected
rooms; all routes require `X-Server-Password` when the server has one.

`RoomState` = `{ name, createdAt, protected, members: [{ peerId, nickname, role,
joinedAt, lastSeen }], offers: [{ from, to, sessionId, bundle, createdAt }],
answers: [{ from, to, sessionId, bundle, createdAt }] }`.

Signal `bundle`s are the `SignalBundle` objects produced by
`defuss-webrtc`'s `ManualPeer`; the server treats them opaquely and only
checks `kind` / `sessionId` / `peerId` shape.

## Limitations (demo grade)

- Passwords are shared secrets, not per-member auth: anyone with a room's
  password can act as any member of it. No rate limiting on password checks.
- In-memory state: restarting the server empties all rooms, and horizontal
  scaling requires a shared store.
- `Access-Control-Allow-Origin: *` on every route.
