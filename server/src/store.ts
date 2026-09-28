export interface Member {
  peerId: string;
  nickname: string;
  role: "moderator" | "member";
  joinedAt: number;
  lastSeen: number;
}

export interface SignalOffer {
  from: string;
  to: string;
  sessionId: string;
  bundle: unknown;
  createdAt: number;
}

export interface SignalAnswer {
  from: string;
  to: string;
  sessionId: string;
  bundle: unknown;
  createdAt: number;
}

export interface RoomSummary {
  name: string;
  memberCount: number;
  createdAt: number;
}

export interface RoomState {
  name: string;
  createdAt: number;
  members: Member[];
  offers: SignalOffer[];
  answers: SignalAnswer[];
}

interface Room {
  name: string;
  createdAt: number;
  members: Map<string, Member>;
  offers: Map<string, SignalOffer>;
  answers: Map<string, SignalAnswer>;
}

export class RoomError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RoomStoreOptions {
  /** Members without a heartbeat for this long are removed. Default 90 s. */
  memberTtlMs?: number;
  /** Offers/answers older than this are garbage-collected. Default 120 s. */
  signalTtlMs?: number;
  /** Clock, injectable for tests. Default Date.now. */
  now?: () => number;
}

const ROOM_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

interface BundleShape {
  kind: string;
  sessionId: string;
  peerId: string;
}

function checkName(name: string): string {
  if (typeof name !== "string" || !ROOM_NAME.test(name)) {
    throw new RoomError(400, "BAD_ROOM_NAME", "Room name must match ^[a-zA-Z0-9_-]{1,64}$");
  }
  return name;
}

function checkId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new RoomError(400, "BAD_ID", `${field} must be a non-empty string of at most 256 chars`);
  }
  return value;
}

function checkNickname(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 64) {
    throw new RoomError(400, "BAD_NICKNAME", "nickname must be a non-empty string of at most 64 chars");
  }
  return value.trim();
}

function checkBundle(value: unknown, kind: "offer" | "answer"): BundleShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoomError(400, "BAD_BUNDLE", "bundle must be an object");
  }
  const bundle = value as Record<string, unknown>;
  if (bundle.kind !== kind) throw new RoomError(400, "BAD_BUNDLE", `bundle.kind must be "${kind}"`);
  if (typeof bundle.sessionId !== "string" || !bundle.sessionId) {
    throw new RoomError(400, "BAD_BUNDLE", "bundle.sessionId must be a non-empty string");
  }
  if (typeof bundle.peerId !== "string" || !bundle.peerId) {
    throw new RoomError(400, "BAD_BUNDLE", "bundle.peerId must be a non-empty string");
  }
  return bundle as unknown as BundleShape;
}

export class RoomStore {
  readonly #rooms = new Map<string, Room>();
  readonly #memberTtlMs: number;
  readonly #signalTtlMs: number;
  readonly #now: () => number;

  constructor(options: RoomStoreOptions = {}) {
    this.#memberTtlMs = options.memberTtlMs ?? 90_000;
    this.#signalTtlMs = options.signalTtlMs ?? 120_000;
    this.#now = options.now ?? Date.now;
  }

  listRooms(): RoomSummary[] {
    return [...this.#rooms.values()]
      .map((room) => ({ name: room.name, memberCount: room.members.size, createdAt: room.createdAt }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  createRoom(name: string, body: { peerId?: unknown; nickname?: unknown }): RoomState {
    checkName(name);
    if (this.#rooms.has(name)) throw new RoomError(409, "ROOM_EXISTS", `Room "${name}" already exists`);
    const room: Room = { name, createdAt: this.#now(), members: new Map(), offers: new Map(), answers: new Map() };
    this.#rooms.set(name, room);
    this.#addMember(room, checkId(body.peerId, "peerId"), checkNickname(body.nickname), "moderator");
    return this.#state(room);
  }

  joinRoom(name: string, body: { peerId?: unknown; nickname?: unknown; offers?: unknown }): RoomState {
    const room = this.#room(name);
    const peerId = checkId(body.peerId, "peerId");
    const nickname = checkNickname(body.nickname);
    if (room.members.has(peerId)) throw new RoomError(409, "ALREADY_JOINED", `Peer ${peerId} is already in room "${name}"`);
    if (!Array.isArray(body.offers)) throw new RoomError(400, "BAD_OFFERS", "offers must be an array");

    // Validate everything before mutating, so a bad offer cannot leave a half-joined member behind.
    const offers = body.offers.map((entry) => {
      const record = entry as { to?: unknown; bundle?: unknown };
      const to = checkId(record?.to, "offers[].to");
      const bundle = checkBundle(record?.bundle, "offer");
      if (to === peerId) throw new RoomError(400, "BAD_OFFERS", "cannot address an offer to yourself");
      if (!room.members.has(to)) throw new RoomError(400, "BAD_OFFERS", `offer target ${to} is not a member of room "${name}"`);
      if (bundle.peerId !== peerId) throw new RoomError(400, "BAD_BUNDLE", "offer bundle peerId must match the joining peerId");
      return { to, bundle };
    });

    this.#addMember(room, peerId, nickname, "member");
    for (const offer of offers) this.#storeOffer(room, { from: peerId, to: offer.to, bundle: offer.bundle });
    return this.#state(room);
  }

  getState(name: string, heartbeatPeerId?: string): RoomState {
    const room = this.#room(name);
    if (heartbeatPeerId) {
      const member = room.members.get(heartbeatPeerId);
      if (member) member.lastSeen = this.#now();
    }
    return this.#state(room);
  }

  addOffer(name: string, body: { from?: unknown; to?: unknown; bundle?: unknown }): void {
    const room = this.#room(name);
    const from = checkId(body.from, "from");
    const to = checkId(body.to, "to");
    this.#member(room, from);
    this.#member(room, to);
    if (from === to) throw new RoomError(400, "BAD_OFFER", "cannot address an offer to yourself");
    const bundle = checkBundle(body.bundle, "offer");
    if (bundle.peerId !== from) throw new RoomError(400, "BAD_BUNDLE", "offer bundle peerId must match from");
    this.#storeOffer(room, { from, to, bundle });
  }

  addAnswer(name: string, body: { from?: unknown; to?: unknown; sessionId?: unknown; bundle?: unknown }): void {
    const room = this.#room(name);
    const from = checkId(body.from, "from");
    const to = checkId(body.to, "to");
    const sessionId = checkId(body.sessionId, "sessionId");
    this.#member(room, from);
    this.#member(room, to);
    const bundle = checkBundle(body.bundle, "answer");
    if (bundle.peerId !== from) throw new RoomError(400, "BAD_BUNDLE", "answer bundle peerId must match from");
    if (bundle.sessionId !== sessionId) throw new RoomError(400, "BAD_BUNDLE", "answer bundle sessionId must match sessionId");
    if (room.answers.has(sessionId)) return; // duplicate delivery is fine
    const offer = room.offers.get(sessionId);
    if (!offer) throw new RoomError(404, "OFFER_NOT_FOUND", `No pending offer with sessionId ${sessionId}`);
    if (offer.from !== to || offer.to !== from) {
      throw new RoomError(400, "ANSWER_MISMATCH", "answer does not correspond to the stored offer");
    }
    room.offers.delete(sessionId);
    room.answers.set(sessionId, { from, to, sessionId, bundle, createdAt: this.#now() });
  }

  leave(name: string, body: { peerId?: unknown }): void {
    const room = this.#room(name);
    const peerId = checkId(body.peerId, "peerId");
    this.#member(room, peerId);
    this.#removeMember(room, peerId);
  }

  /** Drop timed-out members and stale offers/answers. Call periodically. */
  sweep(): void {
    const now = this.#now();
    for (const room of [...this.#rooms.values()]) {
      for (const member of [...room.members.values()]) {
        if (now - member.lastSeen > this.#memberTtlMs) this.#removeMember(room, member.peerId);
      }
      for (const [sessionId, offer] of [...room.offers]) {
        if (now - offer.createdAt > this.#signalTtlMs) room.offers.delete(sessionId);
      }
      for (const [sessionId, answer] of [...room.answers]) {
        if (now - answer.createdAt > this.#signalTtlMs) room.answers.delete(sessionId);
      }
    }
  }

  #room(name: string): Room {
    checkName(name);
    const room = this.#rooms.get(name);
    if (!room) throw new RoomError(404, "ROOM_NOT_FOUND", `Room "${name}" does not exist`);
    return room;
  }

  #member(room: Room, peerId: string): Member {
    const member = room.members.get(peerId);
    if (!member) throw new RoomError(404, "NOT_A_MEMBER", `Peer ${peerId} is not a member of room "${room.name}"`);
    return member;
  }

  #addMember(room: Room, peerId: string, nickname: string, role: Member["role"]): void {
    const now = this.#now();
    room.members.set(peerId, { peerId, nickname, role, joinedAt: now, lastSeen: now });
  }

  #storeOffer(room: Room, offer: { from: string; to: string; bundle: BundleShape }): void {
    const sessionId = offer.bundle.sessionId;
    if (room.offers.has(sessionId)) throw new RoomError(409, "OFFER_EXISTS", `An offer with sessionId ${sessionId} is already stored`);
    room.offers.set(sessionId, { from: offer.from, to: offer.to, sessionId, bundle: offer.bundle, createdAt: this.#now() });
  }

  #removeMember(room: Room, peerId: string): void {
    room.members.delete(peerId);
    for (const [sessionId, offer] of [...room.offers]) {
      if (offer.from === peerId || offer.to === peerId) room.offers.delete(sessionId);
    }
    for (const [sessionId, answer] of [...room.answers]) {
      if (answer.from === peerId || answer.to === peerId) room.answers.delete(sessionId);
    }
    if (room.members.size === 0) {
      this.#rooms.delete(room.name);
      return;
    }
    if (![...room.members.values()].some((member) => member.role === "moderator")) {
      const oldest = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0]!;
      oldest.role = "moderator";
    }
  }

  #state(room: Room): RoomState {
    return {
      name: room.name,
      createdAt: room.createdAt,
      members: [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((member) => ({ ...member })),
      offers: [...room.offers.values()].map((offer) => ({ ...offer })),
      answers: [...room.answers.values()].map((answer) => ({ ...answer })),
    };
  }
}
