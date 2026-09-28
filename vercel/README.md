# defuss-webrtc — Vercel Functions signaling server

Protocol-compatible Vercel Functions implementation of [`../server/PROTOCOL.md`](../server/PROTOCOL.md).
It uses Upstash Redis REST as shared state, so independent Vercel Function invocations and instances see the same rooms.

## Why CAS instead of process memory

The protocol requires atomic joins and atomic offer→answer consumption. Each room is stored as one revision-tagged JSON document.
Every mutation is computed in TypeScript and committed with a Redis Lua compare-and-swap (CAS). Concurrent writers retry from the
newest revision; no distributed lock lease is required. The room JSON and global room index are updated atomically in the same script.

Presence/signal GC is lazy on room access and room listing. Room keys additionally expire after 180 s as a dead-room safety net.

## Deploy

1. In Vercel, create/import the project with **Root Directory = `vercel`**.
2. Add an Upstash Redis database via the Vercel Marketplace (prefer a region close to the Function region).
3. Ensure either environment-variable pair exists:
   - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or
   - `KV_REST_API_URL` + `KV_REST_API_TOKEN`.
4. Optional: set `SERVER_PASSWORD` to require a server password (see below).
5. Deploy. `vercel.json` pins the Function to `fra1`; change that if your Redis primary is elsewhere.

CLI equivalent:

```bash
cd vercel
npm install
npx vercel
```

The public protocol base remains `/v1`; no client changes are required.

## Passwords (optional)

Same semantics as the Express server (`PROTOCOL.md` §2.1):

- **Server password**: set the `SERVER_PASSWORD` environment variable; every `/v1` request must then send it in
  `X-Server-Password` (else `401 BAD_SERVER_PASSWORD`). It is checked before routing and body parsing.
- **Room password**: pass `password` when creating a room; every later request for that room must send it in
  `X-Room-Password` (else `401 BAD_ROOM_PASSWORD`). Room lists and states expose only `protected: true`.

Header values are `encodeURIComponent(password)`. The room password is persisted in the room's Redis document only as a
salted HMAC-SHA256 (`src/auth.ts`, identical to the Express server's) and is stripped from every response
(`toPublicState`). It is verified *inside* the CAS operation, against the same room revision being read or mutated, so a
room deleted and recreated under the same name with a different password can never be accessed with the old one. Room
documents written before password support have no `password` field and read as open rooms.

Vercel terminates TLS for you; still add rate limiting (e.g. Vercel Firewall rules) if the deployment is public, since
password checks are online-guessable.

## Local verification

```bash
npm install
npm test
npm run check
```

For end-to-end local calls, configure `.env.local` with Redis credentials and run `npx vercel dev`.

## Routes

- `GET /v1/rooms`
- `POST /v1/rooms/:name`
- `POST /v1/rooms/:name/join`
- `GET /v1/rooms/:name/members?peerId=...`
- `POST /v1/rooms/:name/offers`
- `POST /v1/rooms/:name/answers`
- `POST /v1/rooms/:name/leave`

CORS (including the two password headers), 256 KiB body limit, protocol error envelopes, optional server/room passwords,
90 s member TTL, and 120 s signal TTL match `PROTOCOL.md`. Error precedence matches the Express server: server password →
body parsing → unknown room (`404`) → room password (`401`) → body validation.

## Concurrency invariant

A stored room is `{ revision, room }`, where `revision` is a fresh UUID for every commit. A mutation reads revision `r`, computes the next state, then Lua commits only if Redis still
contains revision `r`. If another request won first, the mutation retries. UUID revisions also prevent ABA when a room is deleted and recreated with the same name. State-dependent errors are returned only after a
revision check confirms the snapshot is still current. This makes join validate+write and answer consume+store linearizable per room.
