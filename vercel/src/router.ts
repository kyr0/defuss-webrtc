import { ROOM_PASSWORD_HEADER, SERVER_PASSWORD_HEADER, readPasswordHeader, safeEqual } from "./auth.ts";
import { RoomError } from "./errors.ts";
import type { RoomService } from "./service.ts";

const MAX_BODY_BYTES = 256 * 1024;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": `Content-Type, ${SERVER_PASSWORD_HEADER}, ${ROOM_PASSWORD_HEADER}`,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...CORS_HEADERS } });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: CORS_HEADERS });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_BODY_BYTES) {
    throw new RoomError(413, "BAD_REQUEST", "Request body exceeds 256 KB");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new RoomError(413, "BAD_REQUEST", "Request body exceeds 256 KB");
  }
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    throw new RoomError(400, "BAD_REQUEST", "Malformed JSON body");
  }
}

function requestPath(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("__path") ?? url.pathname;
}

function roomName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new RoomError(400, "BAD_ROOM_NAME", "Room name is not valid URL encoding");
  }
}

export interface HandlerOptions {
  /** Optional server-wide password (PROTOCOL.md §2.1); every /v1 request must then send it. */
  serverPassword?: string;
}

function checkServerPassword(request: Request, serverPassword: string | undefined): void {
  if (!serverPassword) return;
  const provided = readPasswordHeader(request.headers.get(SERVER_PASSWORD_HEADER) ?? undefined);
  if (provided !== undefined && safeEqual(provided, serverPassword)) return;
  throw new RoomError(401, "BAD_SERVER_PASSWORD", provided === undefined ? "This server requires a password" : "Wrong server password");
}

export function createHandler(service: RoomService, options: HandlerOptions = {}): (request: Request) => Promise<Response> {
  const serverPassword = options.serverPassword || undefined;
  return async (request) => {
    try {
      if (request.method === "OPTIONS") return empty(204);

      const path = requestPath(request).replace(/\/$/, "") || "/";
      const url = new URL(request.url);
      // Before routing and body parsing, so nothing leaks without the server password.
      if (path === "/v1" || path.startsWith("/v1/")) checkServerPassword(request, serverPassword);
      const roomPassword = readPasswordHeader(request.headers.get(ROOM_PASSWORD_HEADER) ?? undefined);

      if (request.method === "GET" && path === "/v1/rooms") {
        return json(await service.listRooms());
      }

      let match = path.match(/^\/v1\/rooms\/([^/]+)\/members$/);
      if (request.method === "GET" && match) {
        return json(await service.getState(roomName(match[1]!), url.searchParams.get("peerId") ?? undefined, roomPassword));
      }

      match = path.match(/^\/v1\/rooms\/([^/]+)\/join$/);
      if (request.method === "POST" && match) {
        return json(await service.joinRoom(roomName(match[1]!), await readJson(request), roomPassword));
      }

      match = path.match(/^\/v1\/rooms\/([^/]+)\/offers$/);
      if (request.method === "POST" && match) {
        await service.addOffer(roomName(match[1]!), await readJson(request), roomPassword);
        return json({ ok: true }, 201);
      }

      match = path.match(/^\/v1\/rooms\/([^/]+)\/answers$/);
      if (request.method === "POST" && match) {
        await service.addAnswer(roomName(match[1]!), await readJson(request), roomPassword);
        return json({ ok: true }, 201);
      }

      match = path.match(/^\/v1\/rooms\/([^/]+)\/leave$/);
      if (request.method === "POST" && match) {
        await service.leave(roomName(match[1]!), await readJson(request), roomPassword);
        return json({ ok: true });
      }

      match = path.match(/^\/v1\/rooms\/([^/]+)$/);
      if (request.method === "POST" && match) {
        return json(await service.createRoom(roomName(match[1]!), await readJson(request)), 201);
      }

      return json({ error: "NOT_FOUND", message: `Unknown route: ${request.method} ${path}` }, 404);
    } catch (error) {
      if (error instanceof RoomError) return json({ error: error.code, message: error.message }, error.status);
      console.error(error);
      return json({ error: "INTERNAL", message: "Internal server error" }, 500);
    }
  };
}
