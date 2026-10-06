import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Writable } from "node:stream";
import winston from "winston";
import { LOG_DIR, NODE_ENV } from "./config";

/**
 * loguru-styled logger on top of the mature winston module.
 *
 * - Levels: debug(默认)/info/success/warn/error with emoji glyphs.
 * - Console transport (colorized when not in production) at debug level.
 * - An event file transport writing to <LOG_DIR>/<yyyy-mm-dd>/server.log.
 * - A request-bound detail transport writing only for synthesis and phonetic
 *   requests to <LOG_DIR>/<yyyy-mm-dd>/<HHMMSS>_request-id_<requestId>.log.
 */

const LEVEL_EMOJI: Record<string, string> = {
  debug: "🐞",
  info: "ℹ️",
  success: "✅",
  warn: "⚠️",
  error: "❌",
};

const LEVEL_ANSI: Record<string, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  success: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const ANSI_RESET = "\x1b[0m";

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function nowStamp(): string {
  const d = new Date();
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${ms} `;
}

function stampForFile(d = new Date()): { date: string; time: string } {
  return {
    date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
    time: `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`,
  };
}

interface LogLineInfo {
  level: string;
  message: string;
}

export type RequestLogKind = "语音合成" | "注音请求";

export interface RequestLogContext {
  requestId: string;
  kind?: RequestLogKind;
  detailFile?: string;
}

function buildLine(info: LogLineInfo): string {
  const emoji = LEVEL_EMOJI[info.level] || "▪️";
  return `${nowStamp()} | ${info.level.toUpperCase()} | ${emoji} ${info.message}`;
}

const requestLogStorage = new AsyncLocalStorage<RequestLogContext>();

function detailFilePath(requestId: string): string {
  const { date, time } = stampForFile();
  const safeId = requestId.replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(LOG_DIR, date);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${time}_request-id_${safeId}.log`);
}

function appendChunk(filePath: string, chunk: Buffer | string): void {
  fs.appendFileSync(filePath, chunk);
}

function sanitizeLogValue(
  value: unknown,
  key?: string,
  seen = new WeakSet<object>(),
): unknown {
  if (key && /^(api[_-]?key|authorization|password|token|secret)$/i.test(key)) {
    return "[redacted]";
  }

  if (Buffer.isBuffer(value)) {
    return `[binary data redacted: ${value.byteLength} bytes]`;
  }

  if (typeof value === "string") {
    if (key && /ref[_-]?audio/i.test(key)) {
      return /^data:/i.test(value.trim()) ? "embedded audio data" : value;
    }
    if (key && /(?:audio|base64)/i.test(key) && value.length > 256) {
      return "[audio data redacted]";
    }
    return value.replace(
      /data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi,
      "[embedded audio data]",
    );
  }

  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, undefined, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = sanitizeLogValue(childValue, childKey, seen);
  }
  return result;
}

export function formatLogData(value: unknown): string {
  const sanitized = sanitizeLogValue(value);
  if (typeof sanitized === "string") return sanitized;
  try {
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return String(sanitized);
  }
}

export function createRequestLogContext(
  kind?: RequestLogKind,
  requestId = crypto.randomBytes(4).toString("hex"),
): RequestLogContext {
  const context: RequestLogContext = { requestId, kind };
  if (kind) {
    context.detailFile = detailFilePath(requestId);
    fs.closeSync(fs.openSync(context.detailFile, "a"));
  }
  return context;
}

export function runWithRequestLog<T>(
  context: RequestLogContext,
  callback: () => T,
): T {
  return requestLogStorage.run(context, callback);
}

export function currentRequestLog(): RequestLogContext | undefined {
  return requestLogStorage.getStore();
}

export function logHttpResponse(
  method: string,
  url: string,
  statusCode: number,
  body: unknown,
): void {
  const bodyText = body === undefined ? "" : `\n${formatLogData(body)}`;
  const message = `📤 [${method}] ${url} HTTP ${statusCode}${bodyText}`;
  if (statusCode >= 500) {
    logger.error(message);
  } else {
    logger.warn(message);
  }
}

/** A writable that appends events to the current day's server.log. */
const eventStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const { date } = stampForFile();
      const dir = path.join(LOG_DIR, date);
      fs.mkdirSync(dir, { recursive: true });
      appendChunk(path.join(dir, "server.log"), chunk);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  },
});

/** A writable that appends only to the current request's detail file. */
const requestStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const context = currentRequestLog();
      if (context?.detailFile) appendChunk(context.detailFile, chunk);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  },
});

const colorize = NODE_ENV !== "production";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "debug",
  transports: [
    new winston.transports.Console({
      format: winston.format.printf((info) => {
        let line = buildLine(info as LogLineInfo);
        if (colorize) {
          const color = LEVEL_ANSI[info.level] || "";
          line = `${color}${line}${ANSI_RESET}`;
        }
        return line;
      }),
    }),
    new winston.transports.Stream({
      stream: eventStream,
      format: winston.format.printf((info) => buildLine(info as LogLineInfo)),
    }),
    new winston.transports.Stream({
      stream: requestStream,
      format: winston.format.printf((info) => buildLine(info as LogLineInfo)),
    }),
  ],
});

// Convenience aliases
logger.success = logger.info.bind(logger) as unknown as typeof logger.info;

export { logger };