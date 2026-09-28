# defuss-webrtc room signaling protocol — v1

This document specifies the room signaling protocol exactly, so that any
implementation (Node/Express, Vercel Functions, Cloudflare Workers, …) and any
client interoperate. The key words **MUST**, **SHOULD** and **MAY** are to be
interpreted as in RFC 2119.

## 1. Purpose and scope

The server is a *rendezvous* service: it lets peers that want to join the same
named room exchange WebRTC session descriptions (offers/answers) until every
peer holds a direct `RTCDataChannel` to every other peer (full mesh). After
signaling completes, **no application traffic passes through the server** —
chat/state sync is pure P2P.

The server does not interpret signaling payloads beyond a minimal shape check;
it is deliberately usable with any SDP-based signaling, though it is designed
around `defuss-webrtc`'s `SignalBundle` format
(`defuss-webrtc/manual-signal/1`).

## 2. Transport

- HTTP/1.1+, JSON request and response bodies (`Content-Type: application/json`).
- Base path: `/v1`.
- CORS: servers SHOULD allow any origin (`Access-Control-Allow-Origin: *`),
  allow the `Content-Type` header, allow `GET, POST, OPTIONS`, and answer
  `OPTIONS` preflights with `204`.
- Servers SHOULD reject JSON bodies larger than 256 KB with `413`.
- A room name **MUST** match `^[a-zA-Z0-9_-]{1,64}$`. Room names in URLs are
  percent-encoded by clients.

## 3. Data model

All timestamps are numbers: milliseconds since the Unix epoch.

### 3.1 Member

```json
{
  "peerId": "string, 1..256 chars",
  "nickname": "string, trimmed, 1..64 chars",
  "role": "moderator | member",
  "joinedAt": 1790547398643,
  "lastSeen": 1790547398643
}
```

- `peerId` is the client's stable identity (and CRDT actor id). It is unique
  per room.
- Exactly one member per room has `role: "moderator"` at any time.
- `joinedAt` is the server's receive time of the create/join request and
  defines a total order over members; clients use it for tie-breaking (§6.4).
- `lastSeen` drives presence (§7).

### 3.2 SignalOffer / SignalAnswer

```json
{
  "from": "<peerId of sender>",
  "to": "<peerId of the single addressed member>",
  "sessionId": "<unique signaling session id>",
  "bundle": { /* opaque signaling payload, see §3.3 */ },
  "createdAt": 1790547398643
}
```

Offers and answers are keyed by `sessionId`. An offer is addressed to exactly
one member; broadcast offers do not exist.

### 3.3 Signal bundle (opaque passthrough)

The server treats `bundle` as opaque. It **MUST** only validate:

- `bundle` is a JSON object;
- `bundle.kind` is `"offer"` or `"answer"` and **MUST** match the endpoint
  semantics;
- `bundle.sessionId` is a non-empty string;
- `bundle.peerId` is a non-empty string and **MUST** equal the sender
  (`from` / the joining `peerId`).

With `defuss-webrtc`, bundles additionally carry `protocol`, `version`,
`createdAt`, `description` (SDP), `candidates`, `publicEndpoints`, optional
`metadata` (clients put `nickname` there), and for answers `replyTo` (equal to
`sessionId`). A bundle is complete SDP after ICE gathering — no trickle ICE.

### 3.4 RoomState

Returned by room-creating, join and member-list endpoints:

```json
{
  "name": "lobby",
  "createdAt": 1790547398643,
  "members": [ /* Member[], sorted by joinedAt ascending */ ],
  "offers": [ /* SignalOffer[] */ ],
  "answers": [ /* SignalAnswer[] */ ]
}
```

### 3.5 RoomSummary

```json
{ "name": "lobby", "memberCount": 3, "createdAt": 1790547398643 }
```

## 4. Endpoints

Errors use the envelope of §5 with the listed status codes.

### 4.1 `GET /v1/rooms`

Response `200`: `RoomSummary[]`, sorted by `createdAt` ascending.

### 4.2 `POST /v1/rooms/{name}` — create room

Body: `{ "peerId": "...", "nickname": "..." }`.

- Creates the room and the caller as its first member with
  `role: "moderator"`.
- `201` → `RoomState`.
- `409 ROOM_EXISTS` if the room already exists.
- `400 BAD_ROOM_NAME` / `400 BAD_ID` / `400 BAD_NICKNAME` on invalid input.

### 4.3 `POST /v1/rooms/{name}/join` — join room

Body:

```json
{
  "peerId": "...",
  "nickname": "...",
  "offers": [ { "to": "<member peerId>", "bundle": { "kind": "offer", ... } } ]
}
```

- `offers` contains exactly one offer per existing member the client wants to
  pair with (normally: all of them; see §6.2). `offers` **MAY** be empty.
- Validation is atomic: if any offer is invalid, the member **MUST NOT** be
  added. Per offer: `to` **MUST** be an existing member, `to != peerId`, and
  the bundle checks of §3.3 apply.
- `200` → `RoomState` after the join.
- `404 ROOM_NOT_FOUND`, `409 ALREADY_JOINED`, `400 BAD_OFFERS`,
  `400 BAD_BUNDLE`.

### 4.4 `GET /v1/rooms/{name}/members?peerId=<id>` — poll room state

- Response `200` → `RoomState` (full state; clients filter `offers`/`answers`
  by `to === own peerId`).
- If the `peerId` query parameter names a current member, the server **MUST**
  set that member's `lastSeen` to now. This is the presence heartbeat (§7).
- `404 ROOM_NOT_FOUND`.

### 4.5 `POST /v1/rooms/{name}/offers` — late offer

Body: `{ "from": "...", "to": "...", "bundle": { "kind": "offer", ... } }`.

- Used for mesh repair (§6.4) — an offer posted after joining.
- `from` and `to` **MUST** both be members; `from != to`.
- `201` → `{ "ok": true }`.
- `409 OFFER_EXISTS` if an offer with the same `bundle.sessionId` is stored.
- `404 ROOM_NOT_FOUND` / `404 NOT_A_MEMBER`, `400 BAD_OFFER`,
  `400 BAD_BUNDLE`.

### 4.6 `POST /v1/rooms/{name}/answers` — answer an offer

Body:
`{ "from": "...", "to": "...", "sessionId": "...", "bundle": { "kind": "answer", ... } }`.

- `from`/`to` **MUST** both be members. `bundle.sessionId` **MUST** equal
  `sessionId`.
- The answer **MUST** correspond to a stored offer: that offer has
  `from == answer.to` and `to == answer.from`. Otherwise `400 ANSWER_MISMATCH`.
- On success the stored offer **MUST** be deleted (consumed) and the answer
  stored under `sessionId`.
- Idempotent: posting the same `sessionId` answer again is a `201` no-op.
- `201` → `{ "ok": true }`.
- `404 OFFER_NOT_FOUND` if no pending offer has `sessionId` (and no answer with
  it exists yet), `404 ROOM_NOT_FOUND` / `404 NOT_A_MEMBER`.

### 4.7 `POST /v1/rooms/{name}/leave` — leave room

Body: `{ "peerId": "..." }`.

- Removes the member and **all** offers/answers with `from` or `to` equal to
  that peer.
- If the leaving member was the moderator, the remaining member with the
  smallest `joinedAt` **MUST** be promoted to moderator.
- If the room becomes empty, it **MUST** be deleted.
- `200` → `{ "ok": true }`.
- `404 ROOM_NOT_FOUND` / `404 NOT_A_MEMBER`.

## 5. Errors

```json
{ "error": "MACHINE_READABLE_CODE", "message": "human readable detail" }
```

| Status | Codes |
| --- | --- |
| 400 | `BAD_ROOM_NAME`, `BAD_ID`, `BAD_NICKNAME`, `BAD_OFFERS`, `BAD_OFFER`, `BAD_BUNDLE`, `ANSWER_MISMATCH`, `BAD_REQUEST` (malformed JSON body) |
| 404 | `NOT_FOUND` (unknown route), `ROOM_NOT_FOUND`, `NOT_A_MEMBER`, `OFFER_NOT_FOUND` |
| 409 | `ROOM_EXISTS`, `ALREADY_JOINED`, `OFFER_EXISTS` |
| 413 | body too large |
| 500 | `INTERNAL` |

## 6. Client behavior (the mesh algorithm)

One WebRTC offer can be answered exactly once, so a full mesh of N members
needs N·(N−1)/2 pairwise connections. The protocol assigns offer duty to the
*joining* peer.

### 6.1 Create

Client POSTs §4.2, then polls §4.4.

### 6.2 Join

1. `GET /v1/rooms/{name}/members`.
2. For every member except itself, the joiner creates a fresh offer bundle
   (one `RTCPeerConnection` + ICE gathering each).
3. `POST .../join` with all offers.
4. Start polling §4.4 (recommended interval: 2 s).

### 6.3 Poll processing

On every poll, a client:

1. **Answers to me**: for each `answers[]` entry with `to === myPeerId` whose
   `sessionId` matches a pending outgoing offer, complete the handshake
   (e.g. `acceptAnswer`) exactly once per `sessionId`, then wait for the data
   channel to open.
2. **Offers to me**: for each `offers[]` entry with `to === myPeerId` not yet
   handled, create an answer bundle, `POST .../answers` with
   `{ from: myPeerId, to: offer.from, sessionId: offer.sessionId, bundle }`,
   then wait for the data channel to open. Each `sessionId` **MUST** be
   answered at most once per client.
3. Renders the member list.

### 6.4 Simultaneous-join healing (mesh repair)

Two clients joining at the same time may both fetch a member list that predates
the other, so neither offered to the other. Rule: for any pair of members
without a pairing, the member with the **later `joinedAt`** initiates a late
offer via §4.5. Clients detect this during polling: for each member `m` with
`m.joinedAt < myJoinedAt` and no pending or established pairing with
`m.peerId`, create an offer and `POST .../offers`.

### 6.5 Leave / disconnect

Graceful: `POST .../leave` and close all peer connections. Ungraceful (tab
close): the member is dropped by TTL (§7).

## 7. Presence and garbage collection

- Heartbeat: clients poll §4.4 with `?peerId=<own id>` (recommended every 2 s).
- Members with `now - lastSeen > 90 s` **MUST** be removed; removal cascades
  exactly like §4.7 (signal cleanup, moderator handover, empty-room deletion).
- Offers and answers with `now - createdAt > 120 s` **MUST** be deleted.
- A client that polls and finds itself missing from `members[]` **MUST**
  consider itself removed (timed out) and leave locally.

## 8. Implementation notes

### Atomicity requirements

- §4.3 join is validate-then-write: offer validation and member insertion
  **MUST** be atomic per room (no half-joined state).
- §4.6 answer-consume-offer **MUST** be atomic: two concurrent answers to the
  same offer yield one stored answer and one deleted offer (the loser gets
  `404 OFFER_NOT_FOUND` or a `201` no-op if it is a duplicate).

### Serverless (e.g. Vercel Functions)

The reference implementation (`src/store.ts`) keeps state in process memory,
which does not work for stateless function invocations. Port by keeping the
endpoint handlers as-is and backing the store with a shared external state:

- One Redis/KV document per room holding `{ members, offers, answers }`
  serialized as JSON is sufficient at this scale; read-modify-write per request.
- Use conditional/transactional writes (Redis `WATCH`/`MULTI`, or a Lua script)
  to satisfy §8's atomicity requirements.
- TTLs (§7) can be implemented via key-level expiry on a heartbeat marker key
  per member plus lazy sweeping on reads, instead of a periodic sweeper.
- Deploy the functions in a single region against a single store to avoid
  write-write races across replicas.

### Security

The protocol carries no authentication or authorization: anyone can create,
join, read, answer or leave any room, and `peerId` is self-asserted (clients
may impersonate any identity). This is acceptable for demos and trusted game
groups. Hardening options: per-room join tokens, HMAC-signed `peerId`s, rate
limits, and TLS (which any production deployment should terminate anyway).
