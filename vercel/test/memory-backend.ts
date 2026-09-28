import type { RoomBackend } from "../src/backend.ts";
import type { StoredRoom } from "../src/types.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryBackend implements RoomBackend {
  readonly rooms = new Map<string, StoredRoom>();
  readonly index = new Map<string, number>();

  async get(name: string): Promise<StoredRoom | null> {
    await Promise.resolve();
    const value = this.rooms.get(name);
    return value ? clone(value) : null;
  }

  async compareAndSwap(name: string, expectedRevision: string | null, next: StoredRoom | null): Promise<boolean> {
    await Promise.resolve();
    const current = this.rooms.get(name);
    if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) return false;
    if (next) {
      this.rooms.set(name, clone(next));
      this.index.set(name, next.room.createdAt);
    } else {
      this.rooms.delete(name);
      this.index.delete(name);
    }
    return true;
  }

  async isCurrent(name: string, expectedRevision: string | null): Promise<boolean> {
    await Promise.resolve();
    const current = this.rooms.get(name);
    return expectedRevision === null ? current === undefined : current?.revision === expectedRevision;
  }

  async listNames(): Promise<string[]> {
    await Promise.resolve();
    return [...this.index.entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name);
  }
}
