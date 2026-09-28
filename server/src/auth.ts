import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Request header carrying the server password (percent-encoded UTF-8). */
export const SERVER_PASSWORD_HEADER = "x-server-password";
/** Request header carrying a room password (percent-encoded UTF-8). */
export const ROOM_PASSWORD_HEADER = "x-room-password";

const MAX_PASSWORD_LENGTH = 256;

export interface PasswordHash {
  salt: string;
  hash: string;
}

/**
 * Salted HMAC-SHA256. Rooms are ephemeral (in-memory, TTL-bound), so a fast
 * hash is enough to avoid holding plaintext; it also keeps the per-poll check
 * cheap. Online guessing must be limited by rate limiting, not by hash cost.
 */
export function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(16).toString("base64");
  return { salt, hash: digest(salt, password) };
}

export function verifyPassword(stored: PasswordHash, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  return safeEqual(stored.hash, digest(stored.salt, provided));
}

/** Constant-time string comparison (hashes both sides so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** `undefined` for an absent/empty password, the password otherwise; throws on invalid input. */
export function normalizePassword(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_PASSWORD_LENGTH) {
    throw new TypeError(`password must be a string of at most ${MAX_PASSWORD_LENGTH} chars`);
  }
  return value;
}

/** Decodes a percent-encoded password header; malformed encodings count as no password. */
export function readPasswordHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function digest(salt: string, password: string): string {
  return createHmac("sha256", salt).update(password, "utf8").digest("base64");
}
