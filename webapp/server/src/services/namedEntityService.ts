import { db } from "../db/database";

/**
 * 专有名词标注：数据存 `named_entities` 表（首次由 data/named_entities.json 导入）。
 * 每条可单独启用标记、改类型、改「替换文本」；「注音」时按替换文本改写分段文本。
 */

export interface NamedEntity {
  id: number;
  entity: string;
  type: string;
  occurrences: number;
  replacement: string;
  marked: boolean;
}

export interface NamedEntityPatch {
  entity?: string;
  type?: string;
  occurrences?: number;
  replacement?: string;
  marked?: boolean;
}

export type GlobalReplaceKind = "wrap" | "connector";

export interface GlobalReplaceInput {
  kind: GlobalReplaceKind;
  /** wrap：两侧添加的字符串（空字符串=不加）；connector：连接符替换为的字符串（空=删除）。 */
  value: string;
}

export interface ReplacementRule {
  from: string;
  to: string;
}

interface Row {
  id: number;
  entity: string;
  type: string;
  occurrences: number;
  replacement: string;
  marked: number;
}

const SELECT_COLUMNS = "id, entity, type, occurrences, replacement, marked";

function toNamedEntity(row: Row): NamedEntity {
  return {
    id: row.id,
    entity: row.entity,
    type: row.type,
    occurrences: row.occurrences,
    replacement: row.replacement,
    marked: row.marked === 1,
  };
}

function get(id: number): NamedEntity | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM named_entities WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? toNamedEntity(row) : null;
}

function list(): NamedEntity[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM named_entities ORDER BY sort_order, id`)
    .all() as unknown as Row[];
  return rows.map(toNamedEntity);
}

function types(): string[] {
  const rows = db
    .prepare("SELECT DISTINCT type FROM named_entities ORDER BY type")
    .all() as unknown as { type: string }[];
  return rows.map((row) => row.type);
}

function create(patch: NamedEntityPatch): NamedEntity {
  const entity = String(patch.entity ?? "").trim();
  if (!entity) throw new Error("专有名词不能为空");
  const type = String(patch.type ?? "").trim() || "未分类";
  const replacement = patch.replacement === undefined ? entity : String(patch.replacement);
  const occurrences = Number(patch.occurrences) || 0;
  const { n } = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM named_entities")
    .get() as { n: number };

  const info = db
    .prepare(
      "INSERT INTO named_entities(entity, type, occurrences, replacement, marked, sort_order) VALUES(?, ?, ?, ?, ?, ?)"
    )
    .run(entity, type, occurrences, replacement, patch.marked === false ? 0 : 1, n);

  const created = get(Number(info.lastInsertRowid));
  if (!created) throw new Error("创建专有名词失败");
  return created;
}

function update(id: number, patch: NamedEntityPatch): NamedEntity {
  const current = get(id);
  if (!current) throw new Error("专有名词不存在");

  const entity = patch.entity === undefined ? current.entity : String(patch.entity).trim();
  if (!entity) throw new Error("专有名词不能为空");
  const type = patch.type === undefined ? current.type : String(patch.type).trim() || current.type;
  const replacement =
    patch.replacement === undefined ? current.replacement : String(patch.replacement);
  const occurrences =
    patch.occurrences === undefined ? current.occurrences : Number(patch.occurrences) || 0;
  const marked = patch.marked === undefined ? current.marked : patch.marked;

  db.prepare(
    "UPDATE named_entities SET entity = ?, type = ?, occurrences = ?, replacement = ?, marked = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(entity, type, occurrences, replacement, marked ? 1 : 0, id);

  const updated = get(id);
  if (!updated) throw new Error("专有名词不存在");
  return updated;
}

function remove(id: number): void {
  db.prepare("DELETE FROM named_entities WHERE id = ?").run(id);
}

/**
 * 全局替换：批量改写所有条目的「替换文本」。返回受影响条数。
 * - wrap：`替换文本 = value + 原词 + value`（value 为空则等于原词）
 * - connector：把原词里的连接符（·・-—）替换为 value（value 为空即删除连接符）
 */
function applyGlobal(kind: GlobalReplaceKind, value: string): number {
  const rows = list();
  const updateStmt = db.prepare(
    "UPDATE named_entities SET replacement = ?, updated_at = datetime('now') WHERE id = ?"
  );

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const replacement =
        kind === "wrap"
          ? `${value}${row.entity}${value}`
          : row.entity.replace(/[·・\-—]/g, value);
      updateStmt.run(replacement, row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rows.length;
}

/** 注音用替换规则：仅「已启用标记」且替换文本与原词不同的条目，长词优先。 */
function replacementRules(): ReplacementRule[] {
  const rows = db
    .prepare(
      "SELECT entity, replacement FROM named_entities WHERE marked = 1 ORDER BY LENGTH(entity) DESC, id"
    )
    .all() as unknown as { entity: string; replacement: string }[];
  return rows
    .filter((row) => row.entity && row.entity !== row.replacement)
    .map((row) => ({ from: row.entity, to: row.replacement }));
}

export const namedEntityService = {
  list,
  types,
  get,
  create,
  update,
  remove,
  applyGlobal,
  replacementRules,
};
