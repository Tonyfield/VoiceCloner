import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { DB_PATH, NAMED_ENTITIES_PATH, ensureDirs } from "../config";
import { hashPassword } from "../auth/password";
import { logger } from "../logger";

// node:sqlite (Node >=22.5) built-in driver — no native compilation needed.
ensureDirs();

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_sha256 TEXT NOT NULL,
      preferences TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tts_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      api_url TEXT NOT NULL,
      api_path TEXT NOT NULL DEFAULT '/v1/audio/speech',
      api_key TEXT DEFAULT '',
      parameters_schema_yaml TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      model_id INTEGER,
      params_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'idle',
      progress INTEGER NOT NULL DEFAULT 0,
      segment_count INTEGER NOT NULL DEFAULT 0,
      skip_tts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS voices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_task_errors_task_id ON task_errors(task_id);

    /* 分段标记：用户点赞/点踩（点踩可附反馈，反馈可为空） */
    CREATE TABLE IF NOT EXISTS segment_marks (
      task_id INTEGER NOT NULL,
      segment_key TEXT NOT NULL,
      mark TEXT NOT NULL,
      feedback TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, segment_key)
    );

    /* 分段关键步骤记录：分段 / 注音 / 合成 */
    CREATE TABLE IF NOT EXISTS segment_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      segment_key TEXT NOT NULL,
      step TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      status INTEGER,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_segment_steps_task_key ON segment_steps(task_id, segment_key);

    /* 专有名词标注（数据源：data/named_entities.json，表为空时导入） */
    CREATE TABLE IF NOT EXISTS named_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 0,
      replacement TEXT NOT NULL,
      marked INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_named_entities_type ON named_entities(type);

    /* 每个任务的搜索历史（最多保留最近 100 条，由服务层裁剪） */
    CREATE TABLE IF NOT EXISTS task_search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      case_sensitive INTEGER NOT NULL DEFAULT 0,
      wildcard INTEGER NOT NULL DEFAULT 0,
      mark TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_task_search_history_task ON task_search_history(task_id, id);
  `);

  ensureUserPreferencesColumn();
  seedAdmin();
  seedNamedEntities();
  logger.success("✅ 数据库初始化完成");
}

/** 旧库迁移：为 users 补 preferences 列（JSON 偏好）。 */
function ensureUserPreferencesColumn(): void {
  const cols = db.prepare("PRAGMA table_info(users)").all() as unknown as Array<{ name: string }>;
  if (cols.some((c) => c.name === "preferences")) return;
  db.exec("ALTER TABLE users ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}'");
  logger.info("🧩 users 表已补充 preferences 列");
}

function seedAdmin(): void {
  const row = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
  if (row) return;
  db.prepare(
    "INSERT INTO users(username, password_sha256) VALUES(?, ?)"
  ).run("admin", hashPassword("StanislawLem"));
  logger.info("🔑 已创建初始用户 admin");
}

/** 专有名词表为空时，从 data/named_entities.json 导入（type → { entity: 出现次数 }）。 */
function seedNamedEntities(): void {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM named_entities").get() as { n: number };
  if (n > 0) return;

  let data: Record<string, Record<string, number>>;
  try {
    data = JSON.parse(fs.readFileSync(NAMED_ENTITIES_PATH, "utf8"));
  } catch (error) {
    logger.warn(
      `⚠️  未能导入专有名词（${NAMED_ENTITIES_PATH}）：${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const insert = db.prepare(
    "INSERT OR IGNORE INTO named_entities(entity, type, occurrences, replacement, marked, sort_order) VALUES(?, ?, ?, ?, 1, ?)"
  );
  let order = 0;
  db.exec("BEGIN");
  try {
    for (const [type, items] of Object.entries(data)) {
      for (const [entity, occurrences] of Object.entries(items)) {
        insert.run(entity, type, Number(occurrences) || 0, entity, order++);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  logger.info(`📚 已导入专有名词 ${order} 条（${Object.keys(data).length} 类）`);
}

export { db };