// The library is vendored into ./dist/ so this folder works as a self-contained
// site root (e.g. GitHub Pages). A dynamic import lets us show a visible error
// instead of failing silently when the files are missing or misplaced.
let ManualPeer;
let downloadSignalBundle;
let readSignalFile;
let createCrdtDocument;
let defineSchema;
let list;
let map;
let object;
let register;

function fatal(message) {
  // defuss-shadcn destructive alert, prepended to the page.
  const banner = document.createElement("div");
  banner.className = "alert";
  banner.dataset.variant = "destructive";
  banner.setAttribute("role", "alert");
  const content = document.createElement("div");
  content.className = "alert-content";
  const title = document.createElement("h5");
  title.className = "alert-title";
  title.textContent = "Library failed to load";
  const description = document.createElement("p");
  description.className = "alert-description";
  description.textContent = message;
  content.append(title, description);
  banner.append(content);
  document.querySelector("main").prepend(banner);
}

try {
  ({
    ManualPeer,
    downloadSignalBundle,
    readSignalFile,
    createCrdtDocument,
    defineSchema,
    list,
    map,
    object,
    register,
  } = await import("./dist/index.js"));
} catch (error) {
  fatal(`Could not load the defuss-webrtc library from ./dist/index.js — ${error.message}. Run "npm run build" and copy dist/ next to this page.`);
  throw error;
}

function uuid() {
  // crypto.randomUUID requires a secure context; fall back for http:// testing.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const STATE_PROTOCOL = "defuss-chat/state/1";
const IDENTITY_KEY = "defuss-chat-example/identity";

// ---------------------------------------------------------------------------
// CRDT chat schema: every message carries text, nickname and date/time.
// `messages` is an RGA-style list, so concurrent appends from all peers merge
// conflict-free. `peers` tracks one nickname register per peer id.
// ---------------------------------------------------------------------------
const chatSchema = defineSchema({
  messages: list(),
  peers: map(object({ nickname: register("") })),
});

const $ = (id) => document.getElementById(id);
const nicknameInput = $("nickname");
const identityStatus = $("identity-status");
const stunInput = $("stun-servers");
const createOfferButton = $("create-offer");
const signalFileInput = $("signal-file");
const serverUrlInput = $("server-url");
const serverPasswordInput = $("server-password");
const roomNameInput = $("room-name");
const roomPasswordInput = $("room-password");
const createRoomButton = $("create-room");
const joinRoomButton = $("join-room");
const leaveRoomButton = $("leave-room");
const roomStatus = $("room-status");
const roomsList = $("rooms");
const connectionsList = $("connections");
const netStatus = $("net-status");
const membersEl = $("members");
const messagesEl = $("messages");
const chatForm = $("chat-form");
const messageInput = $("message-input");
const sendButton = chatForm.querySelector("button[type=submit]");
const saveStateButton = $("save-state");
const stateFileInput = $("state-file");
const logEl = $("log");

function log(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

window.addEventListener("error", (event) => log(`Error: ${event.message}`));
window.addEventListener("unhandledrejection", (event) => {
  log(`Error: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`);
});

// ---------------------------------------------------------------------------
// Identity: a stable peer id + nickname, persisted in sessionStorage so it
// survives reloads but every tab is its own peer (two tabs of the same browser
// can join the same room). Restoring a state file continues as that peer: same
// peer id, nickname and chat history.
// ---------------------------------------------------------------------------
function loadIdentity() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(IDENTITY_KEY) ?? "null");
    if (parsed && typeof parsed.peerId === "string" && typeof parsed.nickname === "string") {
      return parsed;
    }
  } catch {
    // fall through to a fresh identity
  }
  const fresh = {
    peerId: uuid(),
    nickname: `anon-${Math.random().toString(36).slice(2, 6)}`,
  };
  sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(fresh));
  return fresh;
}

let identity = loadIdentity();
nicknameInput.value = identity.nickname;

// CRDT actor ("writer") id = peer id + a per-page-load suffix. A reloaded page
// starts a fresh document whose op sequence restarts at 1; with the bare peer id
// its first ops would reuse (actor, seq) pairs the other peers already hold from
// before the reload and be dropped as duplicates. Identity, nickname and message
// ownership keep using the stable peer id.
const pageLoadId = uuid().slice(0, 8);
const actorId = () => `${identity.peerId}#${pageLoadId}`;

// ---------------------------------------------------------------------------
// CRDT documents are per room: the room name is the document id, so state only
// syncs between peers in the same room. Chat is only possible while in a room.
// Documents are cached per room name, so leaving and rejoining keeps history.
// ---------------------------------------------------------------------------
const docsByRoom = new Map(); // room name -> CrdtDocument
let roomDoc = null; // the active room's document (null when not in a room)

function createDoc(actorId, docId) {
  const doc = createCrdtDocument({ id: docId, actorId, schema: chatSchema });
  doc.subscribe(() => {
    renderMessages();
    renderMembers();
  });
  doc.onError((error) => log(`CRDT error ${error.code}: ${error.message}`));
  return doc;
}

function getDoc(name) {
  let doc = docsByRoom.get(name);
  if (doc && doc.actorId !== actorId()) {
    // Identity changed since (state restore): keep the ops, switch the actor.
    const next = createDoc(actorId(), name);
    next.merge(doc.export());
    doc.close();
    docsByRoom.set(name, next);
    doc = next;
  } else if (!doc) {
    doc = createDoc(actorId(), name);
    docsByRoom.set(name, doc);
  }
  return doc;
}

function announceNickname() {
  if (!roomDoc) return;
  // Nested write auto-creates the map entry for our peer id.
  roomDoc.set(["peers", identity.peerId, "nickname"], identity.nickname);
}

// ---------------------------------------------------------------------------
// Connections: one ManualPeer per remote peer, all attached to the same CRDT
// document (the document gossips ops between channels, so this forms a mesh).
// ---------------------------------------------------------------------------
const connections = new Map(); // sessionId -> { peer, channel, remotePeerId, remoteNickname, origin, detach, superseded }
const connecting = new Map(); // sessionId -> ManualPeer whose channel is not open yet
let pendingOffer = null; // { peer, sessionId } — manual signaling only

// Room links: at most one *current* signaling session per remote peer. A newer
// session (re-offer, rejoin, reload) supersedes the old one; only the current
// session's failure frees the slot, so mesh repair pairs with that peer again.
const links = new Map(); // remotePeerId -> current sessionId

function claimLink(remotePeerId, sessionId) {
  const previous = links.get(remotePeerId);
  links.set(remotePeerId, sessionId);
  if (previous && previous !== sessionId) retireSession(previous);
}

function releaseLink(remotePeerId, sessionId) {
  if (links.get(remotePeerId) === sessionId) links.delete(remotePeerId);
}

/** Closes whatever a superseded session still holds (pending offer, half-open or open connection). */
function retireSession(sessionId) {
  const pending = outgoing.get(sessionId);
  if (pending) {
    pending.peer.close();
    outgoing.delete(sessionId);
  }
  connecting.get(sessionId)?.close();
  connecting.delete(sessionId);
  const conn = connections.get(sessionId);
  if (conn?.origin === "room") {
    conn.superseded = true;
    conn.peer.close();
  }
}

// Reconnection tuning.
const POLL_VISIBLE_MS = 2_000;
const POLL_HIDDEN_MS = 15_000; // hidden tabs: still well inside the server's 90 s member TTL
const OFFER_TIMEOUT_MS = 20_000; // unanswered offers are withdrawn and retried
const RETRY_MAX_MS = 60_000; // re-offer backoff cap per remote peer
const DISCONNECT_GRACE_MS = 8_000; // ICE "disconnected" often recovers on its own

function iceServers() {
  const urls = stunInput.value.split(",").map((s) => s.trim()).filter(Boolean);
  return urls.map((url) => ({ urls: url }));
}

function short(id) {
  return id.slice(0, 8);
}

function emptyItem(text) {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = text;
  return item;
}

function badge(text, variant) {
  const el = document.createElement("span");
  el.className = "badge";
  el.dataset.variant = variant;
  el.textContent = text;
  return el;
}

function statusItem(label, status, variant) {
  const item = document.createElement("li");
  const text = document.createElement("span");
  text.textContent = label;
  item.append(text, badge(status, variant));
  return item;
}

async function onCreateOffer() {
  createOfferButton.disabled = true;
  try {
    const peer = new ManualPeer({ peerId: identity.peerId, iceServers: iceServers() });
    log("Gathering ICE candidates via STUN…");
    const offer = await peer.createOffer({ metadata: { nickname: identity.nickname } });
    downloadSignalBundle(offer);
    pendingOffer = { peer, sessionId: offer.sessionId };
    const endpoints = offer.publicEndpoints.map((e) => `${e.address}:${e.port}`).join(", ");
    log(`Offer created (session ${short(offer.sessionId)}). PEER.json downloaded — send it to your peer, then upload their answer file.`);
    log(endpoints ? `STUN-derived public endpoints: ${endpoints}` : "No srflx endpoints found (host candidates only).");
    renderConnections();
  } catch (error) {
    log(`Offer failed: ${error.message}`);
  } finally {
    createOfferButton.disabled = false;
  }
}

async function handleSignalBundle(bundle) {
  if (bundle.kind === "offer") {
    const peer = new ManualPeer({ peerId: identity.peerId, iceServers: iceServers() });
    log(`Offer from ${bundle.metadata?.nickname ?? short(bundle.peerId)} received, gathering ICE candidates…`);
    const answer = await peer.acceptOffer(bundle, { metadata: { nickname: identity.nickname } });
    downloadSignalBundle(answer);
    log("Answer PEER.json downloaded — send it back to the offering peer. Waiting for the channel to open…");
    await connectPeer(peer, bundle.sessionId, bundle.peerId, bundle.metadata?.nickname, "manual");
  } else {
    if (!pendingOffer || pendingOffer.sessionId !== bundle.sessionId) {
      throw new Error("This answer does not match any pending offer. Create an offer first.");
    }
    const { peer } = pendingOffer;
    pendingOffer = null;
    await peer.acceptAnswer(bundle);
    log("Answer accepted. Waiting for the channel to open…");
    await connectPeer(peer, bundle.sessionId, bundle.peerId, bundle.metadata?.nickname, "manual");
  }
}

async function onSignalFile(file) {
  try {
    await handleSignalBundle(await readSignalFile(file));
  } catch (error) {
    log(`Signaling failed: ${error.message}`);
  }
}

async function connectPeer(peer, sessionId, remotePeerId, remoteNickname, origin) {
  const label = remoteNickname ?? short(remotePeerId);
  if (origin === "room") claimLink(remotePeerId, sessionId);
  connecting.set(sessionId, peer);
  let channel;
  try {
    channel = await peer.waitForOpen(30_000);
  } catch (error) {
    const current = connecting.get(sessionId) === peer;
    connecting.delete(sessionId);
    peer.close();
    if (origin === "room") releaseLink(remotePeerId, sessionId);
    if (current) log(`Connection to ${label} failed: ${error.message}${origin === "room" && room ? " — will retry" : ""}`);
    renderConnections();
    if (origin === "room") requestSync();
    return;
  }
  connecting.delete(sessionId);
  if (origin === "room" && links.get(remotePeerId) !== sessionId) {
    peer.close(); // superseded by a newer session while it was opening
    return;
  }

  const conn = { peer, channel, remotePeerId, remoteNickname, origin, detach: null, superseded: false };
  if (roomDoc) conn.detach = roomDoc.attach(channel);
  connections.set(sessionId, conn);

  let graceTimer;
  let dropped = false;
  const drop = (reason) => {
    if (dropped) return;
    dropped = true;
    clearTimeout(graceTimer);
    conn.detach?.();
    if (connections.get(sessionId) === conn) connections.delete(sessionId);
    peer.close();
    if (origin === "room") releaseLink(remotePeerId, sessionId);
    if (!conn.superseded) log(`Connection to ${label} lost (${reason})${origin === "room" && room ? " — reconnecting…" : "."}`);
    renderConnections();
    if (origin === "room") requestSync();
  };
  channel.addEventListener("close", () => drop("channel closed"));
  peer.connection.addEventListener("connectionstatechange", () => {
    const state = peer.connection.connectionState;
    if (state === "failed") drop("connection failed");
    else if (state === "disconnected") {
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        if (peer.connection.connectionState !== "connected") drop("no route to peer");
      }, DISCONNECT_GRACE_MS);
    } else if (state === "connected") clearTimeout(graceTimer);
  });
  log(`Connected to ${label} — ${conn.detach ? "chat state is syncing." : "join a room to start syncing chat."}`);
  renderConnections();
}

// ---------------------------------------------------------------------------
// Room signaling: the joiner creates one offer per existing member and posts
// them with the join; every member polls and answers the offers addressed to
// it. Once answers come back, all peers are pairwise connected (full mesh).
// ---------------------------------------------------------------------------
let room = null; // { name, password, myJoinedAt, pollTimer, lastPollAt }
const outgoing = new Map(); // offer sessionId -> { peer, toPeerId, toNickname, createdAt }
const handledOffers = new Set(); // offer sessionIds we already answered (or skipped as stale)
const acceptedAnswers = new Set(); // answer sessionIds we already consumed
const retries = new Map(); // remotePeerId -> { attempts, notBefore } — re-offer backoff
let lastSyncError = null;
let syncing = false;
let syncQueued = false;

// Passwords travel percent-encoded in headers (header values must be ASCII).
// `roomPassword` is only sent for room endpoints; open rooms ignore it.
async function roomApi(method, path, body, roomPassword) {
  const base = serverUrlInput.value.trim().replace(/\/+$/, "");
  if (!base) throw new Error("Enter a signal server URL first");
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (serverPasswordInput.value) headers["X-Server-Password"] = encodeURIComponent(serverPasswordInput.value);
  if (roomPassword) headers["X-Room-Password"] = encodeURIComponent(roomPassword);
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      // keep the status-based message
    }
    const error = new Error(payload.message ?? `HTTP ${res.status}`);
    error.code = payload.error;
    throw error;
  }
  return res.json();
}

function roomName() {
  const name = roomNameInput.value.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("Room name must match ^[a-zA-Z0-9_-]{1,64}$");
  return name;
}

function nicknameOf(state, peerId) {
  return state.members.find((member) => member.peerId === peerId)?.nickname ?? short(peerId);
}

const roomPath = (name) => `/v1/rooms/${encodeURIComponent(name)}`;

async function createOfferFor(toPeerId, toNickname) {
  const peer = new ManualPeer({ peerId: identity.peerId, iceServers: iceServers() });
  const offer = await peer.createOffer({ metadata: { nickname: identity.nickname } });
  outgoing.set(offer.sessionId, { peer, toPeerId, toNickname, createdAt: Date.now() });
  claimLink(toPeerId, offer.sessionId);
  renderConnections();
  return offer;
}

/**
 * Joins `name` with one fresh offer per member. If the server still lists our
 * peer id — a previous session of this tab, e.g. before a reload — that stale
 * membership is ended first, so the join does not fail with ALREADY_JOINED and
 * the others drop their links to the dead session. If ending it empties the
 * room, the room is created again (with the same password).
 * Returns "joined" or "created".
 */
async function joinWithOffers(name, password) {
  let state = await roomApi("GET", `${roomPath(name)}/members`, undefined, password);
  if (state.members.some((member) => member.peerId === identity.peerId)) {
    log(`The server still lists a previous session of yours in "${name}" — replacing it…`);
    await roomApi("POST", `${roomPath(name)}/leave`, { peerId: identity.peerId }, password).catch(() => {});
    try {
      state = await roomApi("GET", `${roomPath(name)}/members`, undefined, password);
    } catch (error) {
      if (error.code !== "ROOM_NOT_FOUND") throw error;
      await roomApi("POST", roomPath(name), { peerId: identity.peerId, nickname: identity.nickname, password: password || undefined });
      return "created";
    }
  }
  const others = state.members.filter((member) => member.peerId !== identity.peerId);
  const offers = [];
  for (const member of others) {
    offers.push({ to: member.peerId, bundle: await createOfferFor(member.peerId, member.nickname) });
  }
  await roomApi("POST", `${roomPath(name)}/join`, { peerId: identity.peerId, nickname: identity.nickname, offers }, password);
  log(`Joined "${name}" with ${offers.length} offer(s). Waiting for answers…`);
  return "joined";
}

async function onCreateRoom() {
  try {
    const name = roomName();
    const password = roomPasswordInput.value;
    await roomApi("POST", roomPath(name), { peerId: identity.peerId, nickname: identity.nickname, password: password || undefined });
    log(`Room "${name}" created${password ? " (password protected)" : ""} — you are the moderator. Waiting for peers to join…`);
    enterRoom(name, password);
  } catch (error) {
    log(`Create room failed: ${error.message}`);
  }
}

async function onJoinRoom() {
  joinRoomButton.disabled = true;
  try {
    const name = roomName();
    const password = roomPasswordInput.value;
    log(`Joining "${name}"…`);
    if ((await joinWithOffers(name, password)) === "created") log(`Room "${name}" was empty — created it again; you are the moderator.`);
    enterRoom(name, password);
  } catch (error) {
    resetRoomSessions();
    log(`Join failed: ${error.message}`);
  } finally {
    joinRoomButton.disabled = room !== null;
  }
}

function enterRoom(name, password) {
  roomDoc = getDoc(name);
  // Attach any channels that opened before the room was selected (manual flow).
  for (const conn of connections.values()) {
    if (!conn.detach) conn.detach = roomDoc.attach(conn.channel);
  }
  room = { name, password, myJoinedAt: null, pollTimer: null, lastPollAt: Date.now() };
  announceNickname();
  updateRoomUI();
  renderAll();
  requestSync();
}

// ---------------------------------------------------------------------------
// Polling: a self-scheduling loop instead of a fixed interval — fast while the
// tab is visible, slow while hidden, paused while the browser is offline, and
// kicked immediately whenever something needs attention (link lost, back
// online, tab visible again).
// ---------------------------------------------------------------------------
function schedulePoll(delay = document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS) {
  if (!room) return;
  clearTimeout(room.pollTimer);
  room.pollTimer = setTimeout(pollTick, delay);
}

function requestSync() {
  schedulePoll(0);
}

async function pollTick() {
  if (!room) return;
  if (!navigator.onLine) return; // the "online" event restarts the loop
  const gap = Date.now() - room.lastPollAt;
  if (gap > 30_000) log(`Resuming after ${Math.round(gap / 1000)} s without contact — resyncing…`);
  room.lastPollAt = Date.now();
  await syncRoom();
  schedulePoll();
}

async function syncRoom() {
  if (!room) return;
  if (syncing) {
    syncQueued = true;
    return;
  }
  syncing = true;
  try {
    await syncRoomOnce();
  } finally {
    syncing = false;
    if (syncQueued && room) {
      syncQueued = false;
      await syncRoom();
    }
  }
}

async function syncRoomOnce() {
  const { name, password } = room;
  const path = roomPath(name);
  try {
    const state = await roomApi("GET", `${path}/members?peerId=${encodeURIComponent(identity.peerId)}`, undefined, password);
    if (lastSyncError) log("Signaling server reachable again.");
    lastSyncError = null;
    if (!room || room.name !== name) return; // left while the request was in flight
    const me = state.members.find((member) => member.peerId === identity.peerId);
    if (!me) {
      await rejoinRoom("The server no longer lists you (timed out or removed)");
      return;
    }
    room.myJoinedAt ??= me.joinedAt;
    renderRoomStatus(state);
    const now = Date.now();

    // Unanswered offers (the other side is gone or offline) are withdrawn, so
    // mesh repair can retry with backoff.
    for (const [sessionId, pending] of [...outgoing]) {
      if (now - pending.createdAt < OFFER_TIMEOUT_MS) continue;
      pending.peer.close();
      outgoing.delete(sessionId);
      releaseLink(pending.toPeerId, sessionId);
      log(`No answer from ${pending.toNickname ?? short(pending.toPeerId)} yet — will retry.`);
    }

    // Answers addressed to me: complete my outgoing offers.
    for (const answer of state.answers) {
      if (answer.to !== identity.peerId || acceptedAnswers.has(answer.sessionId)) continue;
      const pending = outgoing.get(answer.sessionId);
      if (!pending || answer.from !== pending.toPeerId) continue;
      acceptedAnswers.add(answer.sessionId);
      outgoing.delete(answer.sessionId);
      try {
        await pending.peer.acceptAnswer(answer.bundle);
        log(`Answer from ${nicknameOf(state, answer.from)} accepted, opening channel…`);
        connectPeer(pending.peer, answer.sessionId, answer.from, nicknameOf(state, answer.from), "room");
      } catch (error) {
        releaseLink(answer.from, answer.sessionId);
        log(`Accepting the answer from ${nicknameOf(state, answer.from)} failed: ${error.message}`);
      }
    }

    // Offers addressed to me: answer only the newest per sender — older ones
    // belong to sessions the sender has already given up on.
    const newest = new Map();
    for (const offer of state.offers) {
      if (offer.to !== identity.peerId || handledOffers.has(offer.sessionId)) continue;
      handledOffers.add(offer.sessionId);
      const seen = newest.get(offer.from);
      if (!seen || offer.createdAt > seen.createdAt) newest.set(offer.from, offer);
    }
    for (const offer of newest.values()) {
      try {
        const peer = new ManualPeer({ peerId: identity.peerId, iceServers: iceServers() });
        claimLink(offer.from, offer.sessionId); // supersedes any older (dead) link to this peer
        connecting.set(offer.sessionId, peer);
        const answer = await peer.acceptOffer(offer.bundle, { metadata: { nickname: identity.nickname } });
        await roomApi("POST", `${path}/answers`, { from: identity.peerId, to: offer.from, sessionId: offer.sessionId, bundle: answer }, password);
        log(`Answered the offer from ${nicknameOf(state, offer.from)}, opening channel…`);
        connectPeer(peer, offer.sessionId, offer.from, nicknameOf(state, offer.from), "room");
      } catch (error) {
        connecting.get(offer.sessionId)?.close();
        connecting.delete(offer.sessionId);
        releaseLink(offer.from, offer.sessionId);
        log(`Answering the offer from ${nicknameOf(state, offer.from)} failed: ${error.message}`);
      }
    }

    // Mesh repair: for every earlier member we hold no link with (never paired,
    // or the link died), the later joiner — me — offers. Only one side of a pair
    // ever offers, so there is no offer glare. Retries back off per peer.
    for (const member of state.members) {
      if (member.peerId === identity.peerId || links.has(member.peerId)) continue;
      if (member.joinedAt >= room.myJoinedAt) continue;
      const retry = retries.get(member.peerId) ?? { attempts: 0, notBefore: 0 };
      if (now < retry.notBefore) continue;
      retries.set(member.peerId, { attempts: retry.attempts + 1, notBefore: now + Math.min(RETRY_MAX_MS, 2_500 * 2 ** retry.attempts) });
      try {
        const bundle = await createOfferFor(member.peerId, member.nickname);
        await roomApi("POST", `${path}/offers`, { from: identity.peerId, to: member.peerId, bundle }, password);
        log(`Sent ${retry.attempts ? "a new" : "a late"} offer to ${member.nickname} (mesh repair)`);
      } catch (error) {
        log(`Offer to ${member.nickname} failed: ${error.message}`);
      }
    }
    // Healthy links reset their backoff.
    for (const conn of connections.values()) {
      if (conn.origin === "room" && conn.channel.readyState === "open") retries.delete(conn.remotePeerId);
    }
    renderConnections();
  } catch (error) {
    if (error.message !== lastSyncError) log(`Room sync failed: ${error.message}`);
    lastSyncError = error.message;
  }
}

/** Closes all room signaling sessions (manual connections survive). */
function resetRoomSessions() {
  for (const { peer } of outgoing.values()) peer.close();
  outgoing.clear();
  for (const peer of connecting.values()) peer.close();
  connecting.clear();
  handledOffers.clear();
  acceptedAnswers.clear();
  retries.clear();
  links.clear();
  for (const [sessionId, conn] of [...connections]) {
    if (conn.origin === "room") {
      conn.superseded = true; // closed on purpose: no "lost" log, no repair
      conn.peer.close();
      connections.delete(sessionId);
    } else {
      // Manual connections stay alive, just stop syncing this room's doc.
      conn.detach?.();
      conn.detach = null;
    }
  }
}

/** The server dropped us (e.g. >90 s asleep or offline): join again instead of leaving. */
async function rejoinRoom(reason) {
  const { name, password } = room;
  log(`${reason} — rejoining "${name}"…`);
  resetRoomSessions();
  room.myJoinedAt = null;
  try {
    const outcome = await joinWithOffers(name, password);
    if (outcome === "created") log(`Room "${name}" no longer existed — created it again; you are the moderator.`);
    renderConnections();
  } catch (error) {
    if (error.code === "ROOM_NOT_FOUND") {
      try {
        await roomApi("POST", roomPath(name), { peerId: identity.peerId, nickname: identity.nickname, password: password || undefined });
        log(`Room "${name}" no longer existed — created it again; you are the moderator.`);
        return;
      } catch (createError) {
        error = createError;
      }
    }
    log(`Rejoin failed: ${error.message} — will retry.`);
  }
}

async function onLeaveRoom({ silent = false } = {}) {
  if (!room) return;
  const { name, password, pollTimer } = room;
  clearTimeout(pollTimer);
  room = null;
  roomDoc = null; // stays cached in docsByRoom; history is kept locally
  if (!silent) {
    try {
      await roomApi("POST", `${roomPath(name)}/leave`, { peerId: identity.peerId }, password);
    } catch (error) {
      log(`Leave request failed: ${error.message}`);
    }
  }
  resetRoomSessions();
  roomStatus.textContent = "Create a room or join an existing one.";
  updateRoomUI();
  renderAll();
  refreshRooms();
  log(`Left room "${name}". Chat history is kept locally.`);
}

function updateRoomUI() {
  const inRoom = room !== null;
  serverUrlInput.disabled = inRoom;
  serverPasswordInput.disabled = inRoom;
  roomNameInput.disabled = inRoom;
  roomPasswordInput.disabled = inRoom;
  createRoomButton.disabled = inRoom;
  joinRoomButton.disabled = inRoom;
  leaveRoomButton.disabled = !inRoom;
  messageInput.disabled = !inRoom;
  messageInput.placeholder = !inRoom
    ? "Join a room to chat…"
    : navigator.onLine ? "Type a message…" : "Offline — messages sync when you reconnect";
  sendButton.disabled = !inRoom;
  saveStateButton.disabled = !inRoom;
}

function renderNetStatus() {
  const online = navigator.onLine;
  netStatus.textContent = online ? "online" : "offline";
  netStatus.dataset.variant = online ? "secondary" : "outline";
  netStatus.title = online ? "" : "You can keep writing — messages sync when you reconnect.";
}

function renderRoomStatus(state) {
  const names = state.members.map((member) => {
    const label = member.peerId === identity.peerId ? `${member.nickname} (you)` : member.nickname;
    return member.role === "moderator" ? `${label} ★` : label;
  });
  roomStatus.textContent = `In room "${state.name}" — ${names.join(", ")}`;
}

async function refreshRooms() {
  try {
    renderRooms(await roomApi("GET", "/v1/rooms"));
  } catch (error) {
    roomsList.replaceChildren(emptyItem(/password/i.test(error.message) ? `${error.message}.` : "Signal server unreachable."));
  }
}

function renderRooms(rooms) {
  roomsList.replaceChildren();
  if (!rooms.length) {
    roomsList.append(emptyItem("No rooms yet — create one."));
    return;
  }
  for (const entry of rooms) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "flex items-center gap-2";
    const name = document.createElement("span");
    name.textContent = entry.name;
    label.append(name, badge(`${entry.memberCount} member(s)`, "secondary"));
    if (entry.protected) label.append(badge("password", "outline"));
    item.append(label);
    if (!room) {
      const join = document.createElement("button");
      join.className = "btn";
      join.dataset.variant = "outline";
      join.dataset.size = "sm";
      join.textContent = "Join";
      join.addEventListener("click", () => {
        roomNameInput.value = entry.name;
        if (entry.protected && !roomPasswordInput.value) {
          log(`Room "${entry.name}" is password protected — enter its password, then click Join room.`);
          roomPasswordInput.focus();
          return;
        }
        onJoinRoom();
      });
      item.append(join);
    }
    roomsList.append(item);
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!roomDoc) {
    log("Join a room before chatting.");
    return;
  }
  const text = messageInput.value.trim();
  if (!text) return;
  roomDoc.listInsert(["messages"], roomDoc.state.messages.length, {
    text,
    nickname: identity.nickname,
    at: new Date().toISOString(),
    from: identity.peerId,
  });
  messageInput.value = "";
});

// ---------------------------------------------------------------------------
// Save / restore state (impersonation)
// ---------------------------------------------------------------------------
function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function onSaveState() {
  if (!room || !roomDoc) {
    log("Join a room before saving state.");
    return;
  }
  downloadJson({
    protocol: STATE_PROTOCOL,
    savedAt: new Date().toISOString(),
    peerId: identity.peerId,
    nickname: identity.nickname,
    room: room.name,
    snapshot: roomDoc.export(),
  }, `defuss-chat-state-${room.name}-${short(identity.peerId)}.json`);
  log(`State of room "${room.name}" downloaded. Anyone restoring it continues as you, with your full chat history.`);
}

async function onRestoreState(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.protocol !== STATE_PROTOCOL) throw new Error("Not a defuss chat state file");
    if (typeof data.peerId !== "string" || !data.peerId) throw new Error("State file has no peer id");
    const docId = data.snapshot?.docId;
    if (typeof docId !== "string" || !docId) throw new Error("State file has no room/document id");

    identity = {
      peerId: data.peerId,
      nickname: typeof data.nickname === "string" && data.nickname ? data.nickname : "restored-peer",
    };
    sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    nicknameInput.value = identity.nickname;

    // Re-create the room's document under the impersonated actor id and import
    // the exact op-set of the saved peer. If we're in that room right now,
    // re-attach all live channels to the new doc.
    const next = createDoc(actorId(), docId);
    const imported = next.merge(data.snapshot);
    docsByRoom.get(docId)?.close();
    docsByRoom.set(docId, next);
    if (room && room.name === docId) {
      roomDoc = next;
      for (const conn of connections.values()) conn.detach = next.attach(conn.channel);
      announceNickname();
    }
    renderAll();
    log(`State for room "${docId}" restored (${imported} ops imported). You are now impersonating ${identity.nickname} (${short(identity.peerId)}).`);
  } catch (error) {
    log(`Restore failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderIdentity() {
  identityStatus.textContent = `Peer id: ${identity.peerId}`;
}

function renderConnections() {
  connectionsList.replaceChildren();
  if (pendingOffer) {
    connectionsList.append(statusItem(`Offer ${short(pendingOffer.sessionId)}`, "waiting for answer file", "outline"));
  }
  for (const pending of outgoing.values()) {
    connectionsList.append(statusItem(`→ ${pending.toNickname ?? short(pending.toPeerId)}`, "offer sent", "outline"));
  }
  for (const conn of connections.values()) {
    const state = conn.channel.readyState;
    connectionsList.append(statusItem(
      `${conn.remoteNickname ?? short(conn.remotePeerId)} (${short(conn.remotePeerId)})`,
      `channel ${state}`,
      state === "open" ? "default" : "outline",
    ));
  }
  if (!pendingOffer && !outgoing.size && !connections.size) {
    connectionsList.append(emptyItem("No connections yet."));
  }
}

function renderMembers() {
  if (!roomDoc) {
    membersEl.textContent = "Join a room to see its members.";
    return;
  }
  const peers = roomDoc.state.peers;
  const names = Object.entries(peers)
    .map(([id, peer]) => (id === identity.peerId ? `${peer.nickname} (you)` : peer.nickname))
    .filter(Boolean);
  membersEl.textContent = names.length ? `Known peers: ${names.join(", ")}` : "No peers known yet.";
}

function renderMessages() {
  messagesEl.replaceChildren();
  if (!roomDoc) {
    const hint = document.createElement("div");
    hint.className = "empty";
    hint.textContent = "Join a room to see the chat.";
    messagesEl.append(hint);
    return;
  }
  // Displayed chronologically. The CRDT list order records where each writer
  // believed the end was: a message written before the history synced back (just
  // after a reload, or while offline) would otherwise sort before older messages.
  // List order breaks timestamp ties, so every peer renders the same sequence.
  const messages = roomDoc.state.messages
    .map((message, index) => ({ message, index, at: Date.parse(message.at) || 0 }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ message }) => message);
  for (const message of messages) {
    const row = document.createElement("div");
    row.className = `message${message.from === identity.peerId ? " own" : ""}`;

    const meta = document.createElement("span");
    meta.className = "meta";
    const time = new Date(message.at);
    meta.textContent = `${message.nickname} · ${Number.isNaN(time) ? message.at : time.toLocaleString()}`;

    const body = document.createElement("span");
    body.className = "text";
    body.textContent = message.text;

    row.append(meta, body);
    messagesEl.append(row);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderAll() {
  renderIdentity();
  renderConnections();
  renderMembers();
  renderMessages();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$("set-nickname").addEventListener("click", () => {
  const nickname = nicknameInput.value.trim();
  if (!nickname) return;
  identity = { ...identity, nickname };
  sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  announceNickname();
  renderAll();
  log(`Nickname set to "${nickname}".`);
});

createOfferButton.addEventListener("click", onCreateOffer);
signalFileInput.addEventListener("change", () => {
  const file = signalFileInput.files?.[0];
  signalFileInput.value = "";
  if (file) onSignalFile(file);
});
createRoomButton.addEventListener("click", onCreateRoom);
joinRoomButton.addEventListener("click", onJoinRoom);
leaveRoomButton.addEventListener("click", () => onLeaveRoom());
serverUrlInput.addEventListener("change", refreshRooms);
serverPasswordInput.addEventListener("change", refreshRooms);
saveStateButton.addEventListener("click", onSaveState);
stateFileInput.addEventListener("change", () => {
  const file = stateFileInput.files?.[0];
  stateFileInput.value = "";
  if (file) onRestoreState(file);
});

// Connectivity and page lifecycle: resync the moment we are back, poll slowly
// while hidden, and never poll while the browser knows it is offline.
window.addEventListener("online", () => {
  log("Back online — resyncing…");
  renderNetStatus();
  updateRoomUI();
  if (room) requestSync();
  else refreshRooms();
});
window.addEventListener("offline", () => {
  log("Offline — you can keep writing; messages sync when you reconnect.");
  renderNetStatus();
  updateRoomUI();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    schedulePoll(); // re-arm with the slow, hidden cadence
  } else {
    if (room) requestSync();
    else refreshRooms();
  }
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && room) requestSync(); // restored from the back/forward cache
});

renderAll();
renderNetStatus();
updateRoomUI();
refreshRooms();
// The room list is only useful while choosing a room: skip it while in one,
// while the tab is hidden, and while offline.
setInterval(() => {
  if (!room && !document.hidden && navigator.onLine) refreshRooms();
}, 5000);

// Debug handle for the console/tests.
window.__defuss = { docsByRoom, connections, links, get roomDoc() { return roomDoc; }, get room() { return room; } };
