import express, { type NextFunction, type Request, type Response } from "express";
import { ROOM_PASSWORD_HEADER, SERVER_PASSWORD_HEADER, readPasswordHeader, safeEqual } from "./auth.js";
import { RoomError, RoomStore } from "./store.js";

// Optional server-wide password: when set, every /v1 request must send it.
const serverPassword = process.env.SERVER_PASSWORD || undefined;

const app = express();

// Demo-grade CORS: any origin may call the signaling API.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${SERVER_PASSWORD_HEADER}, ${ROOM_PASSWORD_HEADER}`);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Server password is checked before body parsing and routing, so nothing
// (not even a malformed-JSON 400) is observable without it.
app.use("/v1", (req, _res, next) => {
  if (!serverPassword) return next();
  const provided = readPasswordHeader(req.headers[SERVER_PASSWORD_HEADER]);
  if (provided !== undefined && safeEqual(provided, serverPassword)) return next();
  next(new RoomError(401, "BAD_SERVER_PASSWORD", provided === undefined ? "This server requires a password" : "Wrong server password"));
});

app.use(express.json({ limit: "256kb" }));

const store = new RoomStore();
setInterval(() => store.sweep(), 30_000).unref();

// Every room endpoint except create is gated by the room's (optional) password.
// Attached per route so unknown routes still answer 404 NOT_FOUND.
const roomAuth = (req: Request<{ name: string }>, _res: Response, next: NextFunction) => {
  store.authorize(req.params.name, readPasswordHeader(req.headers[ROOM_PASSWORD_HEADER]));
  next();
};

app.get("/v1/rooms", (_req, res) => {
  res.json(store.listRooms());
});

app.post("/v1/rooms/:name", (req, res) => {
  res.status(201).json(store.createRoom(req.params.name, req.body ?? {}));
});

app.post("/v1/rooms/:name/join", roomAuth, (req, res) => {
  res.json(store.joinRoom(req.params.name, req.body ?? {}));
});

app.get("/v1/rooms/:name/members", roomAuth, (req, res) => {
  const peerId = typeof req.query.peerId === "string" ? req.query.peerId : undefined;
  res.json(store.getState(req.params.name, peerId));
});

app.post("/v1/rooms/:name/offers", roomAuth, (req, res) => {
  store.addOffer(req.params.name, req.body ?? {});
  res.status(201).json({ ok: true });
});

app.post("/v1/rooms/:name/answers", roomAuth, (req, res) => {
  store.addAnswer(req.params.name, req.body ?? {});
  res.status(201).json({ ok: true });
});

app.post("/v1/rooms/:name/leave", roomAuth, (req, res) => {
  store.leave(req.params.name, req.body ?? {});
  res.json({ ok: true });
});

app.use((req, res) => {
  res.status(404).json({ error: "NOT_FOUND", message: `Unknown route: ${req.method} ${req.path}` });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof RoomError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  // Framework errors are mapped to the exact codes and messages of the Vercel
  // implementation, so both servers answer byte-for-byte alike.
  if (error instanceof URIError) {
    // Express failed to percent-decode :name — the only route parameter.
    res.status(400).json({ error: "BAD_ROOM_NAME", message: "Room name is not valid URL encoding" });
    return;
  }
  const bodyErrorType = error && typeof error === "object" && "type" in error ? error.type : undefined;
  if (bodyErrorType === "entity.parse.failed") {
    res.status(400).json({ error: "BAD_REQUEST", message: "Malformed JSON body" });
    return;
  }
  if (bodyErrorType === "entity.too.large") {
    res.status(413).json({ error: "BAD_REQUEST", message: "Request body exceeds 256 KB" });
    return;
  }
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    res.status(error.status).json({ error: "BAD_REQUEST", message: error instanceof Error ? error.message : "Bad request" });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "INTERNAL", message: "Internal server error" });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`defuss-webrtc room server listening on http://localhost:${port}${serverPassword ? " (server password required)" : ""}`);
});
