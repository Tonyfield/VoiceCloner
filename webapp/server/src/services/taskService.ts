import fs from "node:fs";
import path from "node:path";
import { db } from "../db/database";
import { TASKS_DIR } from "../config";
import { logger } from "../logger";
import { sortSegmentKeys } from "./segmentBuilder";
import {
  buildAudioFileName,
  parseAudioFileName,
  segmentContentHash,
  type ParsedAudioName,
} from "./audioFiles";

export type TaskStatus = "idle" | "segmenting" | "ready" | "running" | "paused" | "done" | "error";

export interface SegmentRowData {
  text: string;
  phonetic: string;
  source?: string;
}

export interface SegmentPhoneticUpdate {
  key: string;
  phonetic: string;
  /** 文字增强后的分段文本；省略表示不改写文本。 */
  text?: string;
}

export interface IntermediateBody {
  text: string;
  sources: string[];
  segments: Record<string, SegmentRowData>;
}

/** Process-level cache of parsed intermediate.json keyed by (id, mtime),
 *  so paginated reads / info don't re-parse a large file on every request.
 *  updateSegment rewrites the file → mtime changes → cache auto-invalidates. */
const interCache = new Map<number, { mtimeMs: number; body: IntermediateBody | null }>();
/** 分段内容 hash 缓存，key 为 (id, intermediate.json mtime)，避免轮询时反复重算。 */
const hashCache = new Map<number, { mtimeMs: number; hashes: Map<string, string> }>();

export interface TaskRow {
  id: number;
  name: string;
  model_id: number | null;
  params_json: string;
  status: TaskStatus;
  progress: number;
  segment_count: number;
  skip_tts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function taskDir(id: number): string {
  return path.join(TASKS_DIR, String(id));
}
export function uploadsDir(id: number): string {
  return path.join(taskDir(id), "uploads");
}
/** 生成的中间文件与音频文件均直接放在任务自己的工作目录下。 */
export function intermediateJsonPath(id: number): string {
  return path.join(taskDir(id), "intermediate.json");
}

/** The single uploaded document file for a task (first in uploads dir). */
export function uploadedFilePath(id: number): string | null {
  const dir = uploadsDir(id);
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
  if (!entries.length) return null;
  return path.join(dir, entries[0]);
}

export const taskService = {
  list(): (TaskRow & { files: string[] })[] {
    const rows = db
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC, id DESC")
      .all() as unknown as TaskRow[];
    return rows.map((r) => ({ ...r, files: this.listOutput(r.id) }));
  },

  get(id: number): TaskRow | undefined {
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
  },

  /** 全部任务 id（批量清理用）。 */
  listIds(): number[] {
    const rows = db.prepare("SELECT id FROM tasks").all() as unknown as Array<{ id: number }>;
    return rows.map((r) => r.id);
  },

  exists(name: string): boolean {
    return !!db.prepare("SELECT id FROM tasks WHERE name = ?").get(name);
  },

  create(
    input: { name: string; model_id?: number; params_json?: string; skip_tts?: boolean }
  ): number {
    const info = db
      .prepare(
        `INSERT INTO tasks(name, model_id, params_json, skip_tts)
         VALUES(@name, @model_id, @params_json, @skip_tts)`
      )
      .run({
        name: input.name,
        model_id: input.model_id ?? null,
        params_json: input.params_json || "{}",
        skip_tts: input.skip_tts ? 1 : 0,
      });
    const id = Number(info.lastInsertRowid);
    fs.mkdirSync(uploadsDir(id), { recursive: true });
    logger.success(`✅ 任务已创建: ${input.name} (id=${id})`);
    return id;
  },

  update(id: number, patch: Partial<TaskRow>): void {
    const fields: string[] = [];
    const vals: any[] = [];
    for (const key of ["name", "model_id", "params_json", "skip_tts"]) {
      const v = (patch as any)[key];
      if (v !== undefined) {
        fields.push(`"${key}" = ?`);
        vals.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
      }
    }
    if (!fields.length) return;
    fields.push("updated_at = datetime('now')");
    vals.push(id);
    db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  },

  setStatus(id: number, status: TaskStatus, extra?: { progress?: number; segment_count?: number; error?: string | null }): void {
    const fields: string[] = ['status = ?'];
    const vals: any[] = [status];
    if (extra?.progress !== undefined) { fields.push("progress = ?"); vals.push(Math.round(extra.progress)); }
    if (extra?.segment_count !== undefined) { fields.push("segment_count = ?"); vals.push(extra.segment_count); }
    if (extra?.error !== undefined) { fields.push("error = ?"); vals.push(extra.error); }
    fields.push("updated_at = datetime('now')");
    vals.push(id);
    db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  },

  /** Reset statuses left by a previous process and keep completed audio available. */
  recoverInterruptedTasks(): number {
    const rows = db
      .prepare("SELECT * FROM tasks WHERE status IN ('segmenting', 'running')")
      .all() as unknown as TaskRow[];
    let recovered = 0;

    for (const task of rows) {
      const body = this.readIntermediate(task.id);
      const segmentCount = body ? Object.keys(body.segments).length : 0;
      if (!body || segmentCount === 0) {
        this.setStatus(task.id, "idle", {
          progress: 0,
          segment_count: 0,
          error: null,
        });
        logger.warn(`⚠️ 服务重启恢复任务 ${task.id}: 未完成的${task.status}状态已恢复为空闲`);
        recovered += 1;
        continue;
      }

      if (task.status === "segmenting") {
        this.setStatus(task.id, "ready", {
          progress: 100,
          segment_count: segmentCount,
          error: null,
        });
        logger.warn(`⚠️ 服务重启恢复任务 ${task.id}: 分段结果已保留，状态恢复为待合成`);
        recovered += 1;
        continue;
      }

      if (task.skip_tts) {
        this.setStatus(task.id, "done", {
          progress: 100,
          segment_count: segmentCount,
          error: null,
        });
        logger.warn(`⚠️ 服务重启恢复任务 ${task.id}: 仅分段任务状态恢复为完成`);
        recovered += 1;
        continue;
      }

      const audioCount = this.audioKeys(task.id).size;
      const complete = audioCount >= segmentCount;
      this.setStatus(task.id, complete ? "done" : "ready", {
        progress: complete ? 100 : Math.round((audioCount / segmentCount) * 100),
        segment_count: segmentCount,
        error: null,
      });
      logger.warn(
        `⚠️ 服务重启恢复任务 ${task.id}: 已保留 ${audioCount}/${segmentCount} 段音频，状态恢复为${complete ? "完成" : "待合成"}`,
      );
      recovered += 1;
    }

    return recovered;
  },

  /** Persist the uploaded document file into the task's uploads dir. */
  saveUpload(id: number, fileName: string, buffer: Buffer): string {
    const dir = uploadsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isFile() || entry.isSymbolicLink()) {
        fs.rmSync(path.join(dir, entry.name), { force: true });
      }
    }
    // keep original file name, sanitise a little
    const safe = path.basename(fileName);
    const dest = path.join(dir, safe);
    fs.writeFileSync(dest, buffer);
    return dest;
  },

  clearIntermediate(id: number): void {
    interCache.delete(id);
    hashCache.delete(id);
    const filePath = intermediateJsonPath(id);
    if (!fs.existsSync(filePath)) return;
    fs.rmSync(filePath, { force: true });
  },

  /** Remove a task and delete all its server-side files at once. */
  remove(id: number): void {
    const dir = taskDir(id);
    interCache.delete(id);
    hashCache.delete(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    db.prepare("DELETE FROM task_errors WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM segment_marks WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM segment_steps WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    logger.success(`✅ 任务及其文件已删除: id=${id}`);
  },

  listOutput(id: number): string[] {
    const dir = taskDir(id);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f !== "uploads" && f !== "intermediate.json" && !f.startsWith("."))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  },

  readTaskFile(id: number, name: string): { path: string; name: string } | null {
    const p = path.join(taskDir(id), name);
    if (fs.existsSync(p)) return { path: p, name: path.basename(p) };
    return null;
  },

  /** Read the task's intermediate.json (text + sources + segments), with mtime cache. */
  readIntermediate(id: number): IntermediateBody | null {
    const p = intermediateJsonPath(id);
    if (!fs.existsSync(p)) return null;
    try {
      const st = fs.statSync(p);
      const hit = interCache.get(id);
      if (hit && hit.mtimeMs === st.mtimeMs) return hit.body;
      const body: IntermediateBody = JSON.parse(fs.readFileSync(p, "utf8"));
      interCache.set(id, { mtimeMs: st.mtimeMs, body: body || null });
      return body || null;
    } catch {
      return null;
    }
  },

  /** Segment keys in document order, or [] when intermediate.json is absent/unreadable. */
  segmentKeys(id: number): string[] {
    const body = this.readIntermediate(id);
    return body ? sortSegmentKeys(Object.keys(body.segments)) : [];
  },

  /** 各分段「注音后文本」的内容 hash（key → hash），按 intermediate.json mtime 缓存。 */
  segmentHashes(id: number): Map<string, string> {
    const body = this.readIntermediate(id);
    if (!body) return new Map();
    const p = intermediateJsonPath(id);
    const mtimeMs = fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;
    const hit = hashCache.get(id);
    if (hit && hit.mtimeMs === mtimeMs) return hit.hashes;
    const hashes = new Map<string, string>();
    for (const [key, seg] of Object.entries(body.segments)) {
      hashes.set(key, segmentContentHash(seg));
    }
    hashCache.set(id, { mtimeMs, hashes });
    return hashes;
  },

  /**
   * 服务端权威的「分段 → 当前音频文件名」映射（只含已存在且 key+内容 hash 都匹配的分段）。
   * 同一分段序号下可能同时存在多个不同 hash 的历史音频，只有匹配当前 hash 的才算数。
   */
  audioNameMap(id: number): Record<string, string> {
    const body = this.readIntermediate(id);
    if (!body) return {};
    const hashes = this.segmentHashes(id);
    const byKeyHash = new Map(this.listAudioFiles(id).map((f) => [`${f.key}-${f.hash}`, f.name]));
    const out: Record<string, string> = {};
    for (const key of Object.keys(body.segments)) {
      const name = byKeyHash.get(`${key}-${hashes.get(key)}`);
      if (name) out[key] = name;
    }
    return out;
  },

  /** 任务目录内的音频文件（`<key>-<hash>.<ext>`），一次 readdir 返回全部。 */
  listAudioFiles(id: number): Array<ParsedAudioName & { name: string }> {
    const dir = taskDir(id);
    if (!fs.existsSync(dir)) return [];
    const out: Array<ParsedAudioName & { name: string }> = [];
    for (const name of fs.readdirSync(dir)) {
      const parsed = parseAudioFileName(name);
      if (!parsed) continue;
      out.push({ name, ...parsed });
    }
    return out;
  },

  /** 音频文件 + 文件系统信息（保留期清理用）。 */
  listAudioFilesWithStat(
    id: number
  ): Array<ParsedAudioName & { name: string; path: string; mtimeMs: number; size: number }> {
    const dir = taskDir(id);
    if (!fs.existsSync(dir)) return [];
    const out: Array<ParsedAudioName & { name: string; path: string; mtimeMs: number; size: number }> = [];
    for (const name of fs.readdirSync(dir)) {
      const parsed = parseAudioFileName(name);
      if (!parsed) continue;
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        out.push({ name, ...parsed, path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* 文件在读取间隙被删除则跳过 */
      }
    }
    return out;
  },

  /** Segment keys whose audio matches the segment's current content hash, in document order. */
  audioKeys(id: number): Set<string> {
    const body = this.readIntermediate(id);
    if (!body) return new Set();
    const hashes = this.segmentHashes(id);
    const available = new Set(this.listAudioFiles(id).map((f) => `${f.key}-${f.hash}`));
    const ready = new Set<string>();
    for (const key of sortSegmentKeys(Object.keys(body.segments))) {
      if (available.has(`${key}-${hashes.get(key)}`)) ready.add(key);
    }
    return ready;
  },

  /**
   * 重新分段后按内容 hash 复用旧音频：把 hash 命中、但分段序号已变化的文件重命名为
   * 新分段的 `<newKey>-<hash>.<ext>`。不删除任何未命中的文件。返回复用数量。
   */
  relinkAudioByContent(id: number): number {
    const body = this.readIntermediate(id);
    if (!body) return 0;
    const dir = taskDir(id);
    const files = this.listAudioFiles(id);
    const byHash = new Map<string, Array<ParsedAudioName & { name: string }>>();
    for (const f of files) {
      const list = byHash.get(f.hash) ?? [];
      list.push(f);
      byHash.set(f.hash, list);
    }
    const claimed = new Set<string>();
    let relinked = 0;
    for (const key of sortSegmentKeys(Object.keys(body.segments))) {
      const hash = segmentContentHash(body.segments[key]);
      if (files.some((f) => f.key === key && f.hash === hash)) continue;
      const candidate = (byHash.get(hash) ?? []).find((f) => !claimed.has(f.name));
      if (!candidate) continue;
      const target = path.join(dir, buildAudioFileName(key, hash, candidate.ext));
      fs.rmSync(target, { force: true });
      fs.renameSync(path.join(dir, candidate.name), target);
      claimed.add(candidate.name);
      relinked += 1;
    }
    return relinked;
  },

  /** Ordinal position of each segment key within its source (chapter). */
  sourceOrder(id: number): Record<string, string[]> {
    const body = this.readIntermediate(id);
    if (!body) return {};
    const order: Record<string, string[]> = {};
    for (const key of sortSegmentKeys(Object.keys(body.segments))) {
      const seg = body.segments[key];
      const src = seg?.source || "";
      (order[src] ||= []).push(key);
    }
    return order;
  },

  /** Page of segments for one source, ordered by key (pads like "001"). */
  readSegmentsPage(
    id: number,
    source: string,
    offset: number,
    limit: number
  ): { total: number; offset: number; limit: number; items: (SegmentRowData & { key: string; audio: string | null })[] } {
    const order = this.sourceOrder(id);
    const keys = order[source] ?? [];
    const total = keys.length;
    const safeOffset = Math.max(0, Math.min(offset, total));
    const slice = keys.slice(safeOffset, safeOffset + Math.max(1, limit));
    const hashes = this.segmentHashes(id);
    const available = new Map(this.listAudioFiles(id).map((f) => [`${f.key}-${f.hash}`, f.name]));
    const items = slice.map((key) => {
      const seg = this.getSegment(id, key) || { text: "", phonetic: "" };
      const audio = available.get(`${key}-${hashes.get(key)}`) ?? null;
      return { key, text: seg.text, phonetic: seg.phonetic || "", source, audio };
    });
    return { total, offset: safeOffset, limit, items };
  },

  /** Get one segment (key like "001") from intermediate.json. */
  getSegment(id: number, key: string): { text: string; phonetic: string; source?: string } | undefined {
    const body = this.readIntermediate(id);
    return body?.segments[key];
  },

  /** Update one segment (text / phonetic) and persist intermediate.json. */
  updateSegment(
    id: number,
    key: string,
    patch: { text?: string; phonetic?: string }
  ): { text: string; phonetic: string; source?: string } {
    const body = this.readIntermediate(id);
    if (!body) throw new Error("中间文件不存在，请先运行任务");
    const seg = body.segments[key];
    if (!seg) throw new Error(`段落 ${key} 不存在`);
    if (patch.text !== undefined) seg.text = patch.text;
    if (patch.phonetic !== undefined) seg.phonetic = patch.phonetic;
    fs.writeFileSync(intermediateJsonPath(id), JSON.stringify(body, null, 2), "utf8");
    logger.success(`✅ 段落 ${key} 已更新: id=${id}`);
    return seg;
  },

  /** Update phonetic XML for multiple segments with one validated write. */
  updateSegmentsPhonetic(
    id: number,
    updates: SegmentPhoneticUpdate[]
  ): Array<{ key: string; text: string; phonetic: string; source?: string }> {
    const body = this.readIntermediate(id);
    if (!body) throw new Error("中间文件不存在，请先运行任务");

    const next = JSON.parse(JSON.stringify(body)) as IntermediateBody;
    for (const { key } of updates) {
      if (!next.segments[key]) throw new Error(`段落 ${key} 不存在`);
    }

    for (const { key, phonetic, text } of updates) {
      if (text !== undefined) next.segments[key].text = text;
      next.segments[key].phonetic = phonetic;
    }

    const targetPath = intermediateJsonPath(id);
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
      try {
        fs.renameSync(tempPath, targetPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        fs.rmSync(targetPath, { force: true });
        fs.renameSync(tempPath, targetPath);
      }
    } finally {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
    interCache.delete(id);
    logger.success(`✅ 已批量更新 ${updates.length} 段注音: id=${id}`);
    return updates.map(({ key }) => ({ key, ...next.segments[key] }));
  },

  /** 该分段「当前内容 hash」对应的音频文件路径，或 null。 */
  segmentAudioPath(id: number, key: string): string | null {
    const hash = this.segmentHashes(id).get(key);
    if (!hash) return null;
    const hit = this.listAudioFiles(id).find((f) => f.key === key && f.hash === hash);
    return hit ? path.join(taskDir(id), hit.name) : null;
  },

  /**
   * 一次性数据迁移：把历史遗留的 `audio-<key>.<ext>` 改名为 `<key>-<内容hash>.<ext>`，
   * 使旧语音在新命名规则下可被复用。分段已不存在的文件保持不动。
   * 迁移后不再有旧命名文件，可安全删除本方法。
   */
  migrateLegacyAudioNames(id: number): number {
    const dir = taskDir(id);
    if (!fs.existsSync(dir)) return 0;
    const legacy = fs
      .readdirSync(dir)
      .map((name) => /^audio-(.+)\.([A-Za-z0-9]+)$/.exec(name))
      .filter((m): m is RegExpExecArray => m !== null);
    if (!legacy.length) return 0;

    const body = this.readIntermediate(id);
    let migrated = 0;
    for (const m of legacy) {
      const name = m[0];
      const key = m[1];
      const ext = m[2].toLowerCase();
      const seg = body?.segments?.[key];
      if (!seg) continue;
      const target = path.join(dir, buildAudioFileName(key, segmentContentHash(seg), ext));
      fs.rmSync(target, { force: true });
      fs.renameSync(path.join(dir, name), target);
      migrated += 1;
    }
    return migrated;
  },

  /** 对全部任务执行一次旧音频命名迁移。 */
  migrateAllLegacyAudioNames(): number {
    const rows = db.prepare("SELECT id FROM tasks").all() as unknown as Array<{ id: number }>;
    let total = 0;
    for (const row of rows) {
      const migrated = this.migrateLegacyAudioNames(row.id);
      if (migrated) logger.info(`♻️  任务 ${row.id}: 迁移旧命名音频 ${migrated} 个`);
      total += migrated;
    }
    return total;
  },
};