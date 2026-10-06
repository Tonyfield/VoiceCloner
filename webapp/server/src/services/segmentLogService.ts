import { db } from "../db/database";
import { logger } from "../logger";

/**
 * 分段标记（点赞/点踩，可附反馈）与关键步骤记录（分段/注音/合成）。
 * 步骤记录总是带时间（created_at），合成步骤另记耗时、HTTP 状态与报错。
 */

export type SegmentMark = "like" | "dislike";
export type SegmentStepKind = "segment" | "phonetic" | "synthesize";

export interface SegmentMarkRow {
  segment_key: string;
  mark: SegmentMark;
  feedback: string;
  created_at: string;
  updated_at: string;
}

export interface SegmentStepRow {
  id: number;
  task_id: number;
  segment_key: string;
  step: SegmentStepKind;
  detail: Record<string, unknown>;
  status: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

export interface StepLogOptions {
  status?: number | null;
  durationMs?: number | null;
  error?: string | null;
}

export const segmentLogService = {
  /** 记录单个分段的处理步骤。 */
  logStep(
    taskId: number,
    key: string,
    step: SegmentStepKind,
    detail: Record<string, unknown>,
    opts?: StepLogOptions,
  ): void {
    db.prepare(
      `INSERT INTO segment_steps(task_id, segment_key, step, detail, status, duration_ms, error)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      key,
      step,
      JSON.stringify(detail ?? {}),
      opts?.status ?? null,
      opts?.durationMs ?? null,
      opts?.error ?? null,
    );
  },

  /** 批量记录「分段」步骤（分段完成后一次性写入，使用事务）。 */
  logSteps(rows: Array<{ taskId: number; key: string; step: SegmentStepKind; detail: Record<string, unknown> }>): void {
    if (!rows.length) return;
    const stmt = db.prepare(
      "INSERT INTO segment_steps(task_id, segment_key, step, detail) VALUES(?, ?, ?, ?)",
    );
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        stmt.run(row.taskId, row.key, row.step, JSON.stringify(row.detail ?? {}));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      logger.error(`❌ 批量写入分段步骤失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  /** 某个分段各步骤（按时间正序）。 */
  listSteps(taskId: number, key: string): SegmentStepRow[] {
    const rows = db.prepare(
      `SELECT id, task_id, segment_key, step, detail, status, duration_ms, error, created_at
       FROM segment_steps WHERE task_id = ? AND segment_key = ? ORDER BY id ASC`,
    ).all(taskId, key) as unknown as Array<Omit<SegmentStepRow, "detail"> & { detail: string }>;
    return rows.map((row) => ({
      ...row,
      detail: safeParse(row.detail),
    }));
  },

  /** 设置/取消标记；`mark = null` 表示取消。 */
  setMark(taskId: number, key: string, mark: SegmentMark | null, feedback = ""): void {
    if (!mark) {
      db.prepare("DELETE FROM segment_marks WHERE task_id = ? AND segment_key = ?").run(taskId, key);
      return;
    }
    db.prepare(
      `INSERT INTO segment_marks(task_id, segment_key, mark, feedback) VALUES(?, ?, ?, ?)
       ON CONFLICT(task_id, segment_key) DO UPDATE SET
         mark = excluded.mark,
         feedback = excluded.feedback,
         updated_at = datetime('now')`,
    ).run(taskId, key, mark, feedback ?? "");
  },

  /** 任务下全部标记：key → { mark, feedback }。 */
  listMarks(taskId: number): Record<string, { mark: SegmentMark; feedback: string; updated_at: string }> {
    const rows = db.prepare(
      "SELECT segment_key, mark, feedback, updated_at FROM segment_marks WHERE task_id = ?",
    ).all(taskId) as unknown as SegmentMarkRow[];
    const out: Record<string, { mark: SegmentMark; feedback: string; updated_at: string }> = {};
    for (const row of rows) {
      out[row.segment_key] = { mark: row.mark, feedback: row.feedback, updated_at: row.updated_at };
    }
    return out;
  },

  /** 按标记类型取分段 key 集合。 */
  markedKeys(taskId: number, mark: SegmentMark): Set<string> {
    const rows = db.prepare(
      "SELECT segment_key FROM segment_marks WHERE task_id = ? AND mark = ?",
    ).all(taskId, mark) as unknown as Array<{ segment_key: string }>;
    return new Set(rows.map((r) => r.segment_key));
  },

  clearForTask(taskId: number): void {
    db.prepare("DELETE FROM segment_marks WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM segment_steps WHERE task_id = ?").run(taskId);
  },
};

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
