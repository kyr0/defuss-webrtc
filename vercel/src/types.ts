import type { PasswordHash } from "./auth.ts";

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

/** Public room state as returned to clients (PROTOCOL.md §3.4). */
export interface RoomState {
  name: string;
  createdAt: number;
  protected: boolean;
  members: Member[];
  offers: SignalOffer[];
  answers: SignalAnswer[];
}

export interface RoomSummary {
  name: string;
  memberCount: number;
  createdAt: number;
  protected: boolean;
}

/**
 * Persisted room. Carries the room password hash, which must never reach a
 * client; `toPublicState` projects it to `RoomState`. `password` is optional
 * so records written before password support read as open rooms.
 */
export interface RoomRecord extends Omit<RoomState, "protected"> {
  password?: PasswordHash | null;
}

export interface StoredRoom {
  revision: string;
  room: RoomRecord;
}

export interface BundleShape {
  kind: "offer" | "answer";
  sessionId: string;
  peerId: string;
  [key: string]: unknown;
}
