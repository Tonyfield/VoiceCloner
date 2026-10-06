import { db } from "../db/database";

/**
 * 每个任务的搜索历史：最多保留最近 {@link MAX_ITEMS} 条。
 * 同一条搜索（文本 + 选项）会去重并置顶，避免反复搜索堆满历史。
 */

export const MAX_ITEMS = 100;

export interface SearchHistoryInput {
  query: string;
  caseSensitive?: boolean;
  wildcard?: boolean;
  mark?: string;
}

export interface SearchHistoryItem {
  id: number;
  query: string;
  caseSensitive: boolean;
  wildcard: boolean;
  mark: string;
  createdAt: string;
}

interface Row {
  id: number;
  query: string;
  case_sensitive: number;
  wildcard: number;
  mark: string;
  created_at: string;
}

function toItem(row: Row): SearchHistoryItem {
  return {
    id: row.id,
    query: row.query,
    caseSensitive: row.case_sensitive === 1,
    wildcard: row.wildcard === 1,
    mark: row.mark,
    createdAt: row.created_at,
  };
}

/** 最近 N 条（新的在前）。 */
function list(taskId: number, limit = MAX_ITEMS): SearchHistoryItem[] {
  const rows = db
    .prepare(
      "SELECT id, query, case_sensitive, wildcard, mark, created_at FROM task_search_history WHERE task_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(taskId, limit) as unknown as Row[];
  return rows.map(toItem);
}

/** 记录一次搜索：去重置顶 + 裁剪到最近 MAX_ITEMS 条。返回最新列表。 */
function record(taskId: number, input: SearchHistoryInput): SearchHistoryItem[] {
  const query = String(input.query ?? "").trim();
  if (!query) return list(taskId);

  const caseSensitive = input.caseSensitive ? 1 : 0;
  const wildcard = input.wildcard ? 1 : 0;
  const mark = String(input.mark ?? "");

  db.exec("BEGIN");
  try {
    // 同一条搜索只保留最新一次
    db.prepare(
      "DELETE FROM task_search_history WHERE task_id = ? AND query = ? AND case_sensitive = ? AND wildcard = ? AND mark = ?"
    ).run(taskId, query, caseSensitive, wildcard, mark);
    db.prepare(
      "INSERT INTO task_search_history(task_id, query, case_sensitive, wildcard, mark) VALUES(?, ?, ?, ?, ?)"
    ).run(taskId, query, caseSensitive, wildcard, mark);
    // 只保留最近 MAX_ITEMS 条
    db.prepare(
      "DELETE FROM task_search_history WHERE task_id = ? AND id NOT IN (SELECT id FROM task_search_history WHERE task_id = ? ORDER BY id DESC LIMIT ?)"
    ).run(taskId, taskId, MAX_ITEMS);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return list(taskId);
}

function remove(taskId: number, id: number): void {
  db.prepare("DELETE FROM task_search_history WHERE task_id = ? AND id = ?").run(taskId, id);
}

export const searchHistoryService = { list, record, remove };
