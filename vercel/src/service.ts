import type { RoomBackend } from "./backend.js";
import { RoomError } from "./errors.js";
import {
  addAnswer,
  addOffer,
  authorizeRoom,
  checkName,
  createRoom,
  heartbeat,
  joinRoom,
  leaveRoom,
  sweepRoom,
  toPublicState,
} from "./state.js";
import type { RoomRecord, RoomState, RoomSummary, StoredRoom } from "./types.js";

const MAX_CAS_ATTEMPTS = 24;

export interface RoomServiceOptions {
  now?: () => number;
  revision?: () => string;
}

interface Mutation<T> {
  next: RoomRecord | null;
  value: T;
  changed: boolean;
}

export class RoomService {
  readonly #backend: RoomBackend;
  readonly #now: () => number;
  readonly #revision: () => string;

  constructor(backend: RoomBackend, options: RoomServiceOptions = {}) {
    this.#backend = backend;
    this.#now = options.now ?? Date.now;
    this.#revision = options.revision ?? (() => crypto.randomUUID());
  }

  async listRooms(): Promise<RoomSummary[]> {
    const names = await this.#backend.listNames();
    const summaries = await Promise.all(names.map((name) => this.#readSwept(name)));
    return summaries
      .filter((room): room is RoomRecord => room !== null)
      .map((room) => ({
        name: room.name,
        memberCount: room.members.length,
        createdAt: room.createdAt,
        protected: Boolean(room.password),
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** A non-empty `body.password` makes the room protected (PROTOCOL.md §2.1). */
  async createRoom(name: string, body: { peerId?: unknown; nickname?: unknown; password?: unknown }): Promise<RoomState> {
    checkName(name);
    return this.#mutate(name, (current, now) => {
      if (current) throw new RoomError(409, "ROOM_EXISTS", `Room "${name}" already exists`);
      const next = createRoom(name, body, now);
      return { next, value: toPublicState(next), changed: true };
    });
  }

  // Every room operation below checks `roomPassword` inside the CAS operation,
  // i.e. against the same room incarnation it mutates — a room deleted and
  // recreated with another password in between cannot slip through.

  async joinRoom(
    name: string,
    body: { peerId?: unknown; nickname?: unknown; offers?: unknown },
    roomPassword?: string,
  ): Promise<RoomState> {
    checkName(name);
    return this.#mutate(name, (current, now) => {
      const room = this.#authorized(name, current, roomPassword);
      const next = joinRoom(room, body, now);
      return { next, value: toPublicState(next), changed: true };
    });
  }

  async getState(name: string, heartbeatPeerId?: string, roomPassword?: string): Promise<RoomState> {
    checkName(name);
    return this.#mutate(name, (current, now) => {
      const room = this.#authorized(name, current, roomPassword);
      const next = heartbeat(room, heartbeatPeerId, now);
      return { next, value: toPublicState(next), changed: next !== room };
    });
  }

  async addOffer(
    name: string,
    body: { from?: unknown; to?: unknown; bundle?: unknown },
    roomPassword?: string,
  ): Promise<void> {
    checkName(name);
    await this.#mutate(name, (current, now) => {
      const room = this.#authorized(name, current, roomPassword);
      const next = addOffer(room, body, now);
      return { next, value: undefined, changed: true };
    });
  }

  async addAnswer(
    name: string,
    body: { from?: unknown; to?: unknown; sessionId?: unknown; bundle?: unknown },
    roomPassword?: string,
  ): Promise<void> {
    checkName(name);
    await this.#mutate(name, (current, now) => {
      const room = this.#authorized(name, current, roomPassword);
      const next = addAnswer(room, body, now);
      return { next, value: undefined, changed: next !== room };
    });
  }

  async leave(name: string, body: { peerId?: unknown }, roomPassword?: string): Promise<void> {
    checkName(name);
    await this.#mutate(name, (current) => {
      const room = this.#authorized(name, current, roomPassword);
      return { next: leaveRoom(room, body), value: undefined, changed: true };
    });
  }

  /** ROOM_NOT_FOUND before BAD_ROOM_PASSWORD before any body validation — same order as the Express server. */
  #authorized(name: string, current: RoomRecord | null, roomPassword: string | undefined): RoomRecord {
    if (!current) throw new RoomError(404, "ROOM_NOT_FOUND", `Room "${name}" does not exist`);
    authorizeRoom(current, roomPassword);
    return current;
  }

  async #readSwept(name: string): Promise<RoomRecord | null> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const stored = await this.#backend.get(name);
      if (!stored) {
        // Removes stale index entries, but only if the room is still absent.
        if (await this.#backend.compareAndSwap(name, null, null)) return null;
        continue;
      }
      const swept = sweepRoom(stored.room, this.#now());
      if (!swept.changed) return swept.room;
      const next = swept.room ? { revision: this.#revision(), room: swept.room } : null;
      if (await this.#backend.compareAndSwap(name, stored.revision, next)) return swept.room;
    }
    throw new Error(`CAS contention exceeded ${MAX_CAS_ATTEMPTS} attempts for room ${name}`);
  }

  async #mutate<T>(
    name: string,
    operation: (current: RoomRecord | null, now: number) => Mutation<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const stored = await this.#backend.get(name);
      const now = this.#now();
      const swept = stored ? sweepRoom(stored.room, now) : { room: null, changed: false };

      let mutation: Mutation<T>;
      try {
        mutation = operation(swept.room, now);
      } catch (error) {
        if (!(error instanceof RoomError)) throw error;

        // If lazy GC changed the snapshot, persist that GC first. A successful
        // CAS is also the linearization point proving the error was evaluated
        // against the current room incarnation.
        if (swept.changed) {
          const sweptStored: StoredRoom | null = swept.room
            ? { revision: this.#revision(), room: swept.room }
            : null;
          if (await this.#backend.compareAndSwap(name, stored?.revision ?? null, sweptStored)) throw error;
          continue;
        }

        if (await this.#backend.isCurrent(name, stored?.revision ?? null)) throw error;
        continue;
      }

      const mustCommit = swept.changed || mutation.changed;
      if (!mustCommit) return mutation.value;

      const next: StoredRoom | null = mutation.next
        ? { revision: this.#revision(), room: mutation.next }
        : null;
      if (await this.#backend.compareAndSwap(name, stored?.revision ?? null, next)) return mutation.value;
    }
    throw new Error(`CAS contention exceeded ${MAX_CAS_ATTEMPTS} attempts for room ${name}`);
  }
}
