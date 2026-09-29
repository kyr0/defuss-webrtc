# Roadmap

Open work, collected while building the signaling servers, the e2e suites and
the reconnection logic. Items carry the evidence that motivated them. Roughly
ordered by value within each section.

## CRDT core — performance and history

Measured with a small game-like schema (two players, x/y registers, HP
counter), ~201 bytes per op on the wire/in snapshots:

| Ops in history | 1k writes | State read (cached) | Snapshot size | Late-joiner merge |
| --- | --- | --- | --- | --- |
| 1,000 | 4.8 ms | 0.01 ms | 190 KiB | 3 ms |
| 30,000 | 3.8 ms | 0.15 ms | 5.7 MiB | 72 ms |
| 60,000 | 4.8 ms | 0.21 ms | 11.5 MiB | 140 ms |

Writes are flat since the state cache and the listener-less notify fast path
(before: ~10 ms per write at 60k ops). What remains:

- **Incremental materialization.** The first `state` read after any op still
  replays every op at every path (≈11 ms at 60k ops); with a subscriber that
  happens on every write. Recompute only the paths an op touches (per-path
  memo invalidated through `#byPath`), so per-write cost with listeners is
  independent of the history length too.
- **Compaction / checkpointing.** The op-set only grows. Superseded ops (older
  register values, counters folded into a base) could be dropped — but
  anti-entropy relies on contiguous per-actor seq prefixes, so ops can only be
  compacted once they are causally stable (acknowledged by all peers). Needs a
  stability protocol and snapshot-based joins. Deliberately excluded in v0.1.
- **Leaner wire/snapshot encoding.** Every op repeats its full actor id
  (≈45 chars with the per-load suffix) and path; a per-message actor/path
  dictionary would shrink history transfers to late joiners considerably.
- **Actor ids accumulate.** Each page load writes as `peerId#<load id>` (this
  prevents seq collisions after reloads), so version vectors grow by one entry
  per reload. Negligible for chat; revisit together with compaction.

## CRDT core — capabilities

- **Schema evolution.** The hello handshake requires byte-identical canonical
  schemas, so any schema change needs every peer to upgrade at once. Today's
  workaround is a versioned document id (`lobby:v2`). Candidate: accept
  additive changes (new fields with initial values) and reject only
  incompatible ones.
- **Multiplexing.** A document permanently rejects a channel on any message
  that is not its own CRDT traffic (other `docId`, other protocol, non-JSON).
  So one channel carries exactly one document and nothing else. Options: route
  by `docId` to several documents, and/or pass through foreign messages to an
  app handler instead of rejecting.
- **Values are JSON, max 64 KiB per op** (`maxMessageBytes`, both sides).
  Binary data would need base64 and would bloat the history — file transfer
  belongs outside the CRDT (see realtime channel below).

## Games and realtime data

- **Unreliable side channel for ephemeral state.** Per-frame data (positions,
  cursors, typing indicators) should not enter the op history. Open a second
  data channel on `peer.connection` (`negotiated: true`, fixed `id` on both
  sides, `ordered: false, maxRetransmits: 0`) for latest-value broadcasts;
  keep durable state (scores, inventory, turn, chat) in the CRDT. Works
  without core changes in principle — needs a prototype, a Playwright test
  proving both channels coexist, and ideally a `ManualPeer` helper for it.
- **One document per match** (`<room>:match-<n>`) as the documented pattern to
  reset history between rounds.
- A shared-todo (or similar) panel in the docs app as a second data type over
  the same connection, with a browser test — proof that non-chat data syncs
  without library changes.

## Library

- **Room client.** Server-based signaling is only implemented in the example
  app (`docs/app.js`); the README shows a fetch sketch. Extract a
  `joinRoom()` client (offers/answers, polling, heartbeat, mesh repair, the
  reconnection logic, passwords) into the package.
- **Docs:** bring `ARCH.md` and `SKILL.md` up to date — server-based
  signaling, reconnection, per-load actor ids, the state cache.

## Signaling servers

- **`HEAD` parity.** Express answers `HEAD` like `GET` (200); the Vercel router
  returns 404 NOT_FOUND. Harmless for clients, misleading for `curl -I`. Treat
  `HEAD` as `GET` without a body in `vercel/src/router.ts` and add an e2e case.
- **Rate limiting** for password checks (both servers) — they are
  online-guessable (PROTOCOL.md §8).
- **Per-member authentication** (session tokens or HMAC-signed peer ids):
  today anyone holding a room password can act as any member.
- **Fewer requests.** Visible tabs poll every 2 s (≈1,800 requests/hour per
  tab in a room; hidden tabs: every 15 s). Ideas: slow down once the mesh is
  complete and no signals are pending, or push via SSE/WebSocket where the
  host allows it. Matters on per-invocation billing.
- **Configurable TTLs** (member 90 s, signal 120 s) via env, so the expiry
  paths can be e2e-tested quickly (today only unit-tested).

## Chat app (docs/)

- **Visible "server unreachable" state.** Signaling failures are only logged
  once; there is no UI state beyond the online/offline badge.
- **Clock skew.** Messages render chronologically by sender timestamp (CRDT
  order breaks ties); a device with a wrong clock places its messages off.
- **Rejoin re-creates emptied rooms.** A tab rejoining a room everyone has
  left creates it again (with the same password) and becomes moderator —
  decide whether that is the desired behavior.
- **TURN configuration** in the UI (only a STUN field today; no credentials
  are bundled).

## Testing and CI

- **Cross-browser.** Browser tests run in Chromium only, with mDNS host
  candidates disabled (`.local` names do not resolve on CI/sandboxed hosts).
  Add Firefox/WebKit projects and a cross-network (TURN) scenario.
- **Live server-password coverage for Vercel.** Production has no
  `SERVER_PASSWORD`; run the suites once against a preview deployment with one.
- **Pages workflow maintenance.** Bump `actions/checkout`, `setup-node`,
  `configure-pages`, `upload-pages-artifact`, `deploy-pages` to their Node 24
  majors (Node 20 actions are deprecated); `ubuntu-latest` moves to Ubuntu 26
  from 2026-10-19.
- **Known platform difference:** Vercel's edge rejects malformed
  percent-encoding in URL paths (plain-text 400) before the function runs; the
  HTTP suite accepts and reports it. Not fixable in app code.
