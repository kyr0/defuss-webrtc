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
// can join the same room). The peer id doubles as the CRDT actor id, which is
// what makes impersonation possible later: restore a state file and you
// continue as that actor.
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
  if (doc && doc.actorId !== identity.peerId) {
    // Identity changed since (state restore): keep the ops, switch the actor.
    const next = createDoc(identity.peerId, name);
    next.merge(doc.export());
    doc.close();
    docsByRoom.set(name, next);
    doc = next;
  } else if (!doc) {
    doc = createDoc(identity.peerId, name);
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
const connections = new Map(); // sessionId -> { peer, channel, remotePeerId, remoteNickname, detach }
const pairings = new Set(); // remote peer ids we offered to, answered, or connected with
let pendingOffer = null; // { peer, sessionId } — manual signaling only

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
  pairings.add(remotePeerId);
  try {
    const channel = await peer.waitForOpen(30_000);
    const conn = { peer, channel, remotePeerId, remoteNickname, origin, detach: null };
    if (roomDoc) conn.detach = roomDoc.attach(channel);
    connections.set(sessionId, conn);
    channel.addEventListener("close", () => {
      connections.delete(sessionId);
      log(`Connection to ${remoteNickname ?? short(remotePeerId)} closed.`);
      renderConnections();
    });
    log(`Connected to ${remoteNickname ?? short(remotePeerId)} — ${conn.detach ? "chat state is syncing." : "join a room to start syncing chat."}`);
    renderConnections();
  } catch (error) {
    log(`Connection to ${remoteNickname ?? short(remotePeerId)} failed: ${error.message}`);
    peer.close();
    renderConnections();
  }
}

// ---------------------------------------------------------------------------
// Room signaling: the joiner creates one offer per existing member and posts
// them with the join; every member polls and answers the offers addressed to
// it. Once answers come back, all peers are pairwise connected (full mesh).
// ---------------------------------------------------------------------------
let room = null; // { name, password, myJoinedAt, pollTimer }
const outgoing = new Map(); // offer sessionId -> { peer, toPeerId, toNickname }
const handledOffers = new Set(); // offer sessionIds we already answered
const acceptedAnswers = new Set(); // answer sessionIds we already consumed
let lastSyncError = null;

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
    let message = `HTTP ${res.status}`;
    try {
      message = (await res.json()).message ?? message;
    } catch {
      // keep the status-based message
    }
    throw new Error(message);
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

async function createOfferFor(toPeerId, toNickname) {
  const peer = new ManualPeer({ peerId: identity.peerId, iceServers: iceServers() });
  const offer = await peer.createOffer({ metadata: { nickname: identity.nickname } });
  outgoing.set(offer.sessionId, { peer, toPeerId, toNickname });
  pairings.add(toPeerId);
  renderConnections();
  return offer;
}

async function onCreateRoom() {
  try {
    const name = roomName();
    const password = roomPasswordInput.value;
    await roomApi("POST", `/v1/rooms/${encodeURIComponent(name)}`, { peerId: identity.peerId, nickname: identity.nickname, password: password || undefined });
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
    const state = await roomApi("GET", `/v1/rooms/${encodeURIComponent(name)}/members`, undefined, password);
    const others = state.members.filter((member) => member.peerId !== identity.peerId);
    log(`Joining "${name}" — creating offers for ${others.length} existing member(s)…`);
    const offers = [];
    for (const member of others) {
      offers.push({ to: member.peerId, bundle: await createOfferFor(member.peerId, member.nickname) });
    }
    await roomApi("POST", `/v1/rooms/${encodeURIComponent(name)}/join`, { peerId: identity.peerId, nickname: identity.nickname, offers }, password);
    log(`Joined "${name}" with ${offers.length} offer(s). Waiting for answers…`);
    enterRoom(name, password);
  } catch (error) {
    log(`Join failed: ${error.message}`);
  } finally {
    joinRoomButton.disabled = false;
  }
}

function enterRoom(name, password) {
  roomDoc = getDoc(name);
  // Attach any channels that opened before the room was selected (manual flow).
  for (const conn of connections.values()) {
    if (!conn.detach) conn.detach = roomDoc.attach(conn.channel);
  }
  room = { name, password, myJoinedAt: null, pollTimer: setInterval(syncRoom, 2000) };
  announceNickname();
  updateRoomUI();
  renderAll();
  syncRoom();
}

async function syncRoom() {
  if (!room) return;
  const { name, password } = room;
  const path = `/v1/rooms/${encodeURIComponent(name)}`;
  try {
    const state = await roomApi("GET", `${path}/members?peerId=${encodeURIComponent(identity.peerId)}`, undefined, password);
    lastSyncError = null;
    const me = state.members.find((member) => member.peerId === identity.peerId);
    if (!me) {
      log(`You are no longer a member of "${name}" (timed out or removed). Leaving.`);
      onLeaveRoom({ silent: true });
      return;
    }
    room.myJoinedAt ??= me.joinedAt;
    renderRoomStatus(state);

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
        log(`Accepting the answer from ${nicknameOf(state, answer.from)} failed: ${error.message}`);
      }
    }

    // Offers addressed to me: answer them and post the answer back.
    for (const offer of state.offers) {
      if (offer.to !== identity.peerId || handledOffers.has(offer.sessionId)) continue;
      handledOffers.add(offer.sessionId);
      pairings.add(offer.from);
      try {
        const peer = new ManualPeer({ peerId: identity.peerId, iceServers: iceServers() });
        const answer = await peer.acceptOffer(offer.bundle, { metadata: { nickname: identity.nickname } });
        await roomApi("POST", `${path}/answers`, { from: identity.peerId, to: offer.from, sessionId: offer.sessionId, bundle: answer }, password);
        log(`Answered the offer from ${nicknameOf(state, offer.from)}, opening channel…`);
        connectPeer(peer, offer.sessionId, offer.from, nicknameOf(state, offer.from), "room");
      } catch (error) {
        log(`Answering the offer from ${nicknameOf(state, offer.from)} failed: ${error.message}`);
      }
    }

    // Mesh repair: if a member joined before me but we never paired (e.g. we
    // joined simultaneously), the later joiner (me) sends a late offer.
    for (const member of state.members) {
      if (member.peerId === identity.peerId || pairings.has(member.peerId)) continue;
      if (member.joinedAt >= room.myJoinedAt) continue;
      try {
        const bundle = await createOfferFor(member.peerId, member.nickname);
        await roomApi("POST", `${path}/offers`, { from: identity.peerId, to: member.peerId, bundle }, password);
        log(`Sent a late offer to ${member.nickname} (mesh repair)`);
      } catch (error) {
        log(`Late offer to ${member.nickname} failed: ${error.message}`);
      }
    }
    renderConnections();
  } catch (error) {
    if (error.message !== lastSyncError) log(`Room sync failed: ${error.message}`);
    lastSyncError = error.message;
  }
}

async function onLeaveRoom({ silent = false } = {}) {
  if (!room) return;
  const { name, password, pollTimer } = room;
  clearInterval(pollTimer);
  room = null;
  roomDoc = null; // stays cached in docsByRoom; history is kept locally
  if (!silent) {
    try {
      await roomApi("POST", `/v1/rooms/${encodeURIComponent(name)}/leave`, { peerId: identity.peerId }, password);
    } catch (error) {
      log(`Leave request failed: ${error.message}`);
    }
  }
  for (const { peer } of outgoing.values()) peer.close();
  outgoing.clear();
  handledOffers.clear();
  acceptedAnswers.clear();
  pairings.clear();
  for (const [sessionId, conn] of [...connections]) {
    if (conn.origin === "room") {
      conn.peer.close();
      connections.delete(sessionId);
    } else {
      // Manual connections stay alive, just stop syncing this room's doc.
      conn.detach?.();
      conn.detach = null;
    }
  }
  roomStatus.textContent = "Create a room or join an existing one.";
  updateRoomUI();
  renderAll();
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
  messageInput.placeholder = inRoom ? "Type a message…" : "Join a room to chat…";
  sendButton.disabled = !inRoom;
  saveStateButton.disabled = !inRoom;
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
    const next = createDoc(identity.peerId, docId);
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
  identityStatus.textContent = `Peer id: ${identity.peerId} (also your CRDT actor id)`;
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
  const messages = roomDoc.state.messages;
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

renderAll();
updateRoomUI();
refreshRooms();
setInterval(refreshRooms, 5000);

// Debug handle for the console/tests.
window.__defuss = { docsByRoom, connections, get roomDoc() { return roomDoc; }, get room() { return room; } };
