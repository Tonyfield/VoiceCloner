import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "./jwt";
import { logger } from "../logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { uid: number; username: string };
    }
  }
}

/** Attach auth payload from Bearer JWT, or reject with 401. */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload) {
    logger.warn("⚠️ 未授权访问被拒绝");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.auth = { uid: payload.uid, username: payload.username };
  next();
}