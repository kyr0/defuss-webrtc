import express, { type NextFunction, type Request, type Response } from "express";
import { RoomError, RoomStore } from "./store.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

// Demo-grade CORS: any origin may call the signaling API.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const store = new RoomStore();
setInterval(() => store.sweep(), 30_000).unref();

app.get("/v1/rooms", (_req, res) => {
  res.json(store.listRooms());
});

app.post("/v1/rooms/:name", (req, res) => {
  res.status(201).json(store.createRoom(req.params.name, req.body ?? {}));
});

app.post("/v1/rooms/:name/join", (req, res) => {
  res.json(store.joinRoom(req.params.name, req.body ?? {}));
});

app.get("/v1/rooms/:name/members", (req, res) => {
  const peerId = typeof req.query.peerId === "string" ? req.query.peerId : undefined;
  res.json(store.getState(req.params.name, peerId));
});

app.post("/v1/rooms/:name/offers", (req, res) => {
  store.addOffer(req.params.name, req.body ?? {});
  res.status(201).json({ ok: true });
});

app.post("/v1/rooms/:name/answers", (req, res) => {
  store.addAnswer(req.params.name, req.body ?? {});
  res.status(201).json({ ok: true });
});

app.post("/v1/rooms/:name/leave", (req, res) => {
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
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    res.status(error.status).json({ error: "BAD_REQUEST", message: error instanceof Error ? error.message : "Bad request" });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "INTERNAL", message: "Internal server error" });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`defuss-webrtc room server listening on http://localhost:${port}`);
});
