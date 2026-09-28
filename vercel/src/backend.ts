import type { StoredRoom } from "./types.ts";

export interface RoomBackend {
  get(name: string): Promise<StoredRoom | null>;
  compareAndSwap(name: string, expectedRevision: string | null, next: StoredRoom | null): Promise<boolean>;
  isCurrent(name: string, expectedRevision: string | null): Promise<boolean>;
  listNames(): Promise<string[]>;
}
