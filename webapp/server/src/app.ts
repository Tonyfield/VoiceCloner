import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import { CLIENT_DIST } from "./config";
import { authRouter } from "./routes/auth";
import { modelsRouter } from "./routes/models";
import { voicesRouter } from "./routes/voices";
import { tasksRouter } from "./routes/tasks";
import { jobsRouter } from "./routes/jobs";
import { namedEntitiesRouter } from "./routes/namedEntities";
import {
  createRequestLogContext,
  currentRequestLog,
  formatLogData,
  logHttpResponse,
  logger,
  runWithRequestLog,
  type RequestLogKind,
} from "./logger";

function detailKindFor(req: Request): RequestLogKind | undefined {
  if (req.method !== "POST") return undefined;
  const route = req.path;
  if (
    /^\/api\/tasks\/[^/]+\/(?:run|tts)$/.test(route) ||
    /^\/api\/tasks\/[^/]+\/segments\/[^/]+\/synthesize$/.test(route)
  ) {
    return "语音合成";
  }
  if (
    /^\/api\/tasks\/[^/]+\/phonetic$/.test(route) ||
    /^\/api\/tasks\/[^/]+\/segments\/[^/]+\/auto-phonetic$/.test(route)
  ) {
    return "注音请求";
  }
  return undefined;
}

export function createApp(): express.Express {
  const app = express();
  app.use(cors());

  app.use((req: Request, res: Response, next: NextFunction) => {
    const context = createRequestLogContext(detailKindFor(req));
    let responseBody: unknown;
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    (res as any).json = (body: unknown) => {
      responseBody = body;
      return originalJson(body);
    };
    (res as any).send = (body: unknown) => {
      if (responseBody === undefined) responseBody = body;
      return originalSend(body);
    };
    res.once("finish", () => {
      runWithRequestLog(context, () => {
        if (res.statusCode >= 400) {
          logHttpResponse(req.method, req.originalUrl, res.statusCode, responseBody);
        }
      });
    });
    res.setHeader("X-Request-Id", context.requestId);
    runWithRequestLog(context, () => {
      if (context.kind) {
        logger.info(
          `📥 ${context.kind} [${req.method}] ${req.originalUrl} request-id=${context.requestId}`,
        );
        if (req.body !== undefined && req.body !== null) {
          logger.info(`📨 ${context.kind} request payload:\n${formatLogData(req.body)}`);
        }
      }
      next();
    });
  });

  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const context = currentRequestLog();
    if (context?.kind && req.body !== undefined && req.body !== null) {
      logger.info(`📨 ${context.kind} request payload:\n${formatLogData(req.body)}`);
    }
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRouter);
  app.use("/api/models", modelsRouter);
  app.use("/api/voices", voicesRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/named-entities", namedEntitiesRouter);

  // serve built frontend if present (production)
  if (fs.existsSync(path.join(CLIENT_DIST, "index.html"))) {
    app.use(express.static(CLIENT_DIST));
    app.get(/^\/(?!api).*/, (req, res) => {
      res.sendFile(path.join(CLIENT_DIST, "index.html"));
    });
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(`❌ 服务器错误: ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  return app;
}