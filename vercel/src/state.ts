import { hashPassword, normalizePassword, verifyPassword } from "./auth.js";
import { RoomError } from "./errors.js";
import type { BundleShape, Member, RoomRecord, RoomState } from "./types.js";

export const MEMBER_TTL_MS = 90_000;
export const SIGNAL_TTL_MS = 120_000;
const ROOM_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function checkName(name: string): string {
  if (typeof name !== "string" || !ROOM_NAME.test(name)) {
    throw new RoomError(400, "BAD_ROOM_NAME", "Room name must match ^[a-zA-Z0-9_-]{1,64}$");
  }
  return name;
}

export function checkId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new RoomError(400, "BAD_ID", `${field} must be a non-empty string of at most 256 chars`);
  }
  return value;
}

export function checkNickname(value: unknown): string {
  if (typeof value !== "string") {
    throw new RoomError(400, "BAD_NICKNAME", "nickname must be a non-empty string of at most 64 chars");
  }
  const nickname = value.trim();
  if (!nickname || nickname.length > 64) {
    throw new RoomError(400, "BAD_NICKNAME", "nickname must be a non-empty string of at most 64 chars");
  }
  return nickname;
}

export function checkPassword(value: unknown): string | undefined {
  try {
    return normalizePassword(value);
  } catch (error) {
    throw new RoomError(400, "BAD_PASSWORD", (error as Error).message);
  }
}

/**
 * Access check for every room operation except create. Throws
 * BAD_ROOM_PASSWORD when a protected room's password is missing or wrong;
 * open rooms accept any (or no) password.
 */
export function authorizeRoom(room: RoomRecord, password: string | undefined): void {
  if (room.password && !verifyPassword(room.password, password)) {
    throw new RoomError(
      401,
      "BAD_ROOM_PASSWORD",
      password === undefined ? `Room "${room.name}" requires a password` : `Wrong password for room "${room.name}"`,
    );
  }
}

/** Projects a stored room to the client-facing shape, dropping the password hash. */
export function toPublicState(room: RoomRecord): RoomState {
  return {
    name: room.name,
    createdAt: room.createdAt,
    protected: Boolean(room.password),
    members: room.members,
    offers: room.offers,
    answers: room.answers,
  };
}

export function checkBundle(value: unknown, kind: "offer" | "answer"): BundleShape {
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
  return bundle as BundleShape;
}

export interface SweepResult {
  room: RoomRecord | null;
  changed: boolean;
}

export function sweepRoom(
  room: RoomRecord,
  now: number,
  memberTtlMs = MEMBER_TTL_MS,
  signalTtlMs = SIGNAL_TTL_MS,
): SweepResult {
  const liveMembers = room.members.filter((member) => now - member.lastSeen <= memberTtlMs);
  const livePeerIds = new Set(liveMembers.map((member) => member.peerId));
  const membersChanged = liveMembers.length !== room.members.length;

  if (liveMembers.length === 0) return { room: null, changed: true };

  const offers = room.offers.filter(
    (offer) =>
      now - offer.createdAt <= signalTtlMs &&
      livePeerIds.has(offer.from) &&
      livePeerIds.has(offer.to),
  );
  const answers = room.answers.filter(
    (answer) =>
      now - answer.createdAt <= signalTtlMs &&
      livePeerIds.has(answer.from) &&
      livePeerIds.has(answer.to),
  );

  let members = liveMembers;
  let moderatorChanged = false;
  if (!members.some((member) => member.role === "moderator")) {
    const oldest = members.reduce((a, b) => (a.joinedAt <= b.joinedAt ? a : b));
    members = members.map((member) =>
      member.peerId === oldest.peerId ? { ...member, role: "moderator" as const } : member,
    );
    moderatorChanged = true;
  }

  const changed =
    membersChanged ||
    moderatorChanged ||
    offers.length !== room.offers.length ||
    answers.length !== room.answers.length;

  if (!changed) return { room, changed: false };
  return { room: { ...room, members, offers, answers }, changed: true };
}

function requireMember(room: RoomRecord, peerId: string): Member {
  const member = room.members.find((candidate) => candidate.peerId === peerId);
  if (!member) throw new RoomError(404, "NOT_A_MEMBER", `Peer ${peerId} is not a member of room "${room.name}"`);
  return member;
}

function nextJoinedAt(room: RoomRecord | null, now: number): number {
  if (!room || room.members.length === 0) return now;
  const max = room.members.reduce((value, member) => Math.max(value, member.joinedAt), Number.MIN_SAFE_INTEGER);
  return Math.max(now, max + 1);
}

function removeMember(room: RoomRecord, peerId: string): RoomRecord | null {
  let members = room.members.filter((member) => member.peerId !== peerId);
  const offers = room.offers.filter((offer) => offer.from !== peerId && offer.to !== peerId);
  const answers = room.answers.filter((answer) => answer.from !== peerId && answer.to !== peerId);
  if (members.length === 0) return null;
  if (!members.some((member) => member.role === "moderator")) {
    const oldest = members.reduce((a, b) => (a.joinedAt <= b.joinedAt ? a : b));
    members = members.map((member) =>
      member.peerId === oldest.peerId ? { ...member, role: "moderator" as const } : member,
    );
  }
  return { ...room, members, offers, answers };
}

/** Creates a room; a non-empty `password` makes every later access to it require that password. */
export function createRoom(
  name: string,
  body: { peerId?: unknown; nickname?: unknown; password?: unknown },
  now: number,
): RoomRecord {
  checkName(name);
  const peerId = checkId(body.peerId, "peerId");
  const nickname = checkNickname(body.nickname);
  const password = checkPassword(body.password);
  return {
    name,
    createdAt: now,
    password: password === undefined ? null : hashPassword(password),
    members: [{ peerId, nickname, role: "moderator", joinedAt: now, lastSeen: now }],
    offers: [],
    answers: [],
  };
}

export function joinRoom(
  room: RoomRecord,
  body: { peerId?: unknown; nickname?: unknown; offers?: unknown },
  now: number,
): RoomRecord {
  const peerId = checkId(body.peerId, "peerId");
  const nickname = checkNickname(body.nickname);
  if (room.members.some((member) => member.peerId === peerId)) {
    throw new RoomError(409, "ALREADY_JOINED", `Peer ${peerId} is already in room "${room.name}"`);
  }
  if (!Array.isArray(body.offers)) throw new RoomError(400, "BAD_OFFERS", "offers must be an array");

  const knownSessions = new Set(room.offers.map((offer) => offer.sessionId));
  const offers = body.offers.map((entry) => {
    const record = entry as { to?: unknown; bundle?: unknown };
    const to = checkId(record?.to, "offers[].to");
    const bundle = checkBundle(record?.bundle, "offer");
    if (to === peerId) throw new RoomError(400, "BAD_OFFERS", "cannot address an offer to yourself");
    if (!room.members.some((member) => member.peerId === to)) {
      throw new RoomError(400, "BAD_OFFERS", `offer target ${to} is not a member of room "${room.name}"`);
    }
    if (bundle.peerId !== peerId) {
      throw new RoomError(400, "BAD_BUNDLE", "offer bundle peerId must match the joining peerId");
    }
    if (knownSessions.has(bundle.sessionId)) {
      throw new RoomError(400, "BAD_OFFERS", `duplicate offer sessionId ${bundle.sessionId}`);
    }
    knownSessions.add(bundle.sessionId);
    return { to, bundle };
  });

  const joinedAt = nextJoinedAt(room, now);
  return {
    ...room,
    members: [...room.members, { peerId, nickname, role: "member", joinedAt, lastSeen: now }],
    offers: [
      ...room.offers,
      ...offers.map((offer) => ({
        from: peerId,
        to: offer.to,
        sessionId: offer.bundle.sessionId,
        bundle: offer.bundle,
        createdAt: now,
      })),
    ],
  };
}

export function heartbeat(room: RoomRecord, peerId: string | undefined, now: number): RoomRecord {
  if (!peerId) return room;
  const index = room.members.findIndex((member) => member.peerId === peerId);
  if (index < 0) return room;
  const members = room.members.slice();
  members[index] = { ...members[index]!, lastSeen: now };
  return { ...room, members };
}

export function addOffer(
  room: RoomRecord,
  body: { from?: unknown; to?: unknown; bundle?: unknown },
  now: number,
): RoomRecord {
  const from = checkId(body.from, "from");
  const to = checkId(body.to, "to");
  requireMember(room, from);
  requireMember(room, to);
  if (from === to) throw new RoomError(400, "BAD_OFFER", "cannot address an offer to yourself");
  const bundle = checkBundle(body.bundle, "offer");
  if (bundle.peerId !== from) throw new RoomError(400, "BAD_BUNDLE", "offer bundle peerId must match from");
  if (room.offers.some((offer) => offer.sessionId === bundle.sessionId)) {
    throw new RoomError(409, "OFFER_EXISTS", `An offer with sessionId ${bundle.sessionId} is already stored`);
  }
  return {
    ...room,
    offers: [
      ...room.offers,
      { from, to, sessionId: bundle.sessionId, bundle, createdAt: now },
    ],
  };
}

export function addAnswer(
  room: RoomRecord,
  body: { from?: unknown; to?: unknown; sessionId?: unknown; bundle?: unknown },
  now: number,
): RoomRecord {
  const from = checkId(body.from, "from");
  const to = checkId(body.to, "to");
  const sessionId = checkId(body.sessionId, "sessionId");
  requireMember(room, from);
  requireMember(room, to);
  const bundle = checkBundle(body.bundle, "answer");
  if (bundle.peerId !== from) throw new RoomError(400, "BAD_BUNDLE", "answer bundle peerId must match from");
  if (bundle.sessionId !== sessionId) {
    throw new RoomError(400, "BAD_BUNDLE", "answer bundle sessionId must match sessionId");
  }
  if (room.answers.some((answer) => answer.sessionId === sessionId)) return room;
  const offer = room.offers.find((candidate) => candidate.sessionId === sessionId);
  if (!offer) throw new RoomError(404, "OFFER_NOT_FOUND", `No pending offer with sessionId ${sessionId}`);
  if (offer.from !== to || offer.to !== from) {
    throw new RoomError(400, "ANSWER_MISMATCH", "answer does not correspond to the stored offer");
  }
  return {
    ...room,
    offers: room.offers.filter((candidate) => candidate.sessionId !== sessionId),
    answers: [...room.answers, { from, to, sessionId, bundle, createdAt: now }],
  };
}

export function leaveRoom(room: RoomRecord, body: { peerId?: unknown }): RoomRecord | null {
  const peerId = checkId(body.peerId, "peerId");
  requireMember(room, peerId);
  return removeMember(room, peerId);
}
