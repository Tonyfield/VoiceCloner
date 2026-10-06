import path from "node:path";
import fs from "node:fs";

export const NODE_ENV = process.env.NODE_ENV || "development";
export const PORT = Number(process.env.PORT || 3000);

/** Data dir: --docker /app/data; local fallback <repo>/webapp/data */
export const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, "..", "data")
);

/** Log dir: --docker /app/log; local fallback <repo>/webapp/log */
export const LOG_DIR = path.resolve(
  process.env.LOG_DIR || path.join(__dirname, "..", "log")
);

export const DB_PATH = path.join(DATA_DIR, "voicecloner.db");
export const TASKS_DIR = path.join(DATA_DIR, "tasks");
export const VOICES_DIR = path.join(DATA_DIR, "voices");
/** 导出/清理等后台任务的临时产物目录。 */
export const JOBS_DIR = path.join(DATA_DIR, "jobs");

export const CEDICT_PATH = path.resolve(
  process.env.CEDICT_PATH ||
    path.join(
      __dirname,
      "..",
      "..",
      "..",
      "data",
      "cedict_1_0_ts_utf-8_mdbg.txt",
    ),
);

/** 专有名词表初始数据（首次为空时导入 named_entities 表）。 */
export const NAMED_ENTITIES_PATH = path.resolve(
  process.env.NAMED_ENTITIES_PATH ||
    path.join(__dirname, "..", "..", "..", "data", "named_entities.json"),
);

/** Static dir of built frontend (only present when client/build is done).
 *  Local dev: <webapp>/client/dist. Docker: /app/client/dist via env. */
export const CLIENT_DIST = path.resolve(
  process.env.CLIENT_DIST || path.join(__dirname, "..", "..", "client", "dist")
);

export const JWT_SECRET =
  process.env.JWT_SECRET || "voicecloner-dev-secret-change-me";

export const MAX_VOICE_BYTES = 5 * 1024 * 1024; // 5MB
export const DEFAULT_MAX_CHARS_PER_SEGMENT = 100;

/** Extra params forwarded as-is when the model schema flag extra_params is set */
export const TTS_DEFAULT_API_KEY = "sk-indextts-v2_5_20260902";

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, LOG_DIR, TASKS_DIR, VOICES_DIR, JOBS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}