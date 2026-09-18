import type { Request, Response } from "express";
import { getRoomCount } from "./rooms.js";
import { INSTANCE_ID } from "./redisPubSub.js";

const startedAt = Date.now();

export function healthcheckHandler(_req: Request, res: Response): void {
  res.status(200).json({
    status: "ok",
    instanceId: INSTANCE_ID,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    activeRooms: getRoomCount(),
  });
}
