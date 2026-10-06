import { db } from "../db/database";
import { logger } from "../logger";
import { getErrorMessage } from "../shared/errors";

export interface TaskErrorRow {
  id: number;
  task_id: number;
  stage: string;
  message: string;
  created_at: string;
}

/** 任务错误历史：重试耗尽后记录，供工作界面右上角查看/清除。 */
export const errorService = {
  record(taskId: number, stage: string, error: unknown): void {
    const message = typeof error === "string" ? error : getErrorMessage(error);
    db.prepare("INSERT INTO task_errors(task_id, stage, message) VALUES(?, ?, ?)").run(
      taskId,
      stage,
      message,
    );
    logger.error(`❌ 任务 ${taskId} 记录错误(${stage}): ${message}`);
  },

  list(taskId: number): TaskErrorRow[] {
    return db
      .prepare(
        "SELECT id, task_id, stage, message, created_at FROM task_errors WHERE task_id = ? ORDER BY id DESC",
      )
      .all(taskId) as unknown as TaskErrorRow[];
  },

  count(taskId: number): number {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM task_errors WHERE task_id = ?")
      .get(taskId) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  clear(taskId: number): number {
    const info = db.prepare("DELETE FROM task_errors WHERE task_id = ?").run(taskId);
    return Number(info.changes ?? 0);
  },
};
