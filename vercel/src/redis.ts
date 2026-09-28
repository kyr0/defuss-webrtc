import { Redis } from "@upstash/redis";
import type { RoomBackend } from "./backend.ts";
import type { StoredRoom } from "./types.ts";

const PREFIX = "{defuss-webrtc}";
const INDEX_KEY = `${PREFIX}:rooms`;
const ROOM_KEY_TTL_MS = 180_000;

const CAS_LUA = `
local raw = redis.call("GET", KEYS[1])
local expected = ARGV[1]
if expected == "" then
  if raw then return 0 end
else
  if not raw then return 0 end
  local ok, current = pcall(cjson.decode, raw)
  if not ok or tostring(current.revision) ~= expected then return 0 end
end

local nextValue = ARGV[2]
local roomName = ARGV[3]
if nextValue == "" then
  redis.call("DEL", KEYS[1])
  redis.call("ZREM", KEYS[2], roomName)
else
  redis.call("SET", KEYS[1], nextValue, "PX", ARGV[5])
  redis.call("ZADD", KEYS[2], ARGV[4], roomName)
end
return 1
`;

const CURRENT_LUA = `
local raw = redis.call("GET", KEYS[1])
local expected = ARGV[1]
if expected == "" then
  if raw then return 0 else return 1 end
end
if not raw then return 0 end
local ok, current = pcall(cjson.decode, raw)
if not ok then return 0 end
if tostring(current.revision) == expected then return 1 else return 0 end
`;

function roomKey(name: string): string {
  return `${PREFIX}:room:${name}`;
}

function parseStored(value: unknown): StoredRoom | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return JSON.parse(value) as StoredRoom;
  return value as StoredRoom;
}

export class UpstashRoomBackend implements RoomBackend {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async get(name: string): Promise<StoredRoom | null> {
    return parseStored(await this.#redis.get(roomKey(name)));
  }

  async compareAndSwap(name: string, expectedRevision: string | null, next: StoredRoom | null): Promise<boolean> {
    const result = await this.#redis.eval(
      CAS_LUA,
      [roomKey(name), INDEX_KEY],
      [
        expectedRevision ?? "",
        next ? JSON.stringify(next) : "",
        name,
        String(next?.room.createdAt ?? 0),
        String(ROOM_KEY_TTL_MS),
      ],
    );
    return Number(result) === 1;
  }

  async isCurrent(name: string, expectedRevision: string | null): Promise<boolean> {
    const result = await this.#redis.evalRo(
      CURRENT_LUA,
      [roomKey(name)],
      [expectedRevision ?? ""],
    );
    return Number(result) === 1;
  }

  async listNames(): Promise<string[]> {
    const names = await this.#redis.zrange(INDEX_KEY, 0, -1);
    return (names as unknown[]).map(String);
  }
}

export function redisFromEnv(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Missing Redis credentials: set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL + KV_REST_API_TOKEN)",
    );
  }
  return new Redis({ url, token, enableTelemetry: false });
}
