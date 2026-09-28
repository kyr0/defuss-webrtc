import { UpstashRoomBackend, redisFromEnv } from "../src/redis.ts";
import { createHandler } from "../src/router.ts";
import { RoomService } from "../src/service.ts";

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
