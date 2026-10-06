import type { Response } from "express";

/** 统一的错误消息提取（Error / string / unknown）。 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 统一的 HTTP 错误响应体：`{ error: string }`。 */
export function sendError(res: Response, status: number, error: unknown): void {
  res.status(status).json({ error: getErrorMessage(error) });
}
