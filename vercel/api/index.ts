import { UpstashRoomBackend, redisFromEnv } from "../src/redis.js";
import { createHandler } from "../src/router.js";
import { RoomService } from "../src/service.js";

let handler: ((request: Request) => Promise<Response>) | undefined;

function getHandler(): (request: Request) => Promise<Response> {
  if (!handler) {
    handler = createHandler(new RoomService(new UpstashRoomBackend(redisFromEnv())), {
      serverPassword: process.env.SERVER_PASSWORD,
    });
  }
  return handler;
}

export default {
  fetch(request: Request): Promise<Response> {
    return getHandler()(request);
  },
};
