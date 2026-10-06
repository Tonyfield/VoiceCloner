import { Router, type Request, type Response } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { taskService, uploadedFilePath, type TaskRow } from "../services/taskService";
import { segmentText, xmlize } from "../services/phonetic";
import { enhanceText, enhanceOptionsFromParams } from "../services/textEnhance";
import { resetTextRulesTrace } from "../services/textRules";
import { namedEntityService } from "../services/namedEntityService";
import { MAX_ITEMS as MAX_HISTORY_ITEMS, searchHistoryService } from "../services/searchHistoryService";
import { prepareTask, requestPause, requestStop, resumeTask, runTask, segmentMaxChars, selectTtsKeys, synthesizeSegment, synthesizeTask } from "../services/taskRunner";
import { errorService } from "../services/errorService";
import { segmentLogService } from "../services/segmentLogService";
import { buildExport, exportFilename, exportToFile, type ExportFormat, type ExportScope } from "../services/exporter";
import { jobService, jobDir, yieldLoop } from "../services/jobService";
import { cleanupTaskAudio } from "../services/cleanupService";
import { requireAuth } from "../auth/middleware";
import { sendError } from "../shared/errors";
import { parseBooleanFlag, parseJsonObject } from "../shared/json";
import { logger } from "../logger";

const upload = multer({ storage: multer.memoryStorage() });

export const tasksRouter = Router();

/** 附加任务已上传文档的原始文件名，供前端展示。 */
function withUploadName<T extends { id: number }>(task: T): T & { upload_name: string | null } {
  const p = uploadedFilePath(task.id);
  return { ...task, upload_name: p ? path.basename(p) : null };
}

tasksRouter.get("/", (_req: Request, res: Response) => {
  res.json(taskService.list().map(withUploadName));
});

function readJson(input: any, key: string, fallback = "{}"): string {
  const v = input?.[key];
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v ?? JSON.parse(fallback));
  } catch {
    return fallback;
  }
}

/** multer decodes legacy multipart filename bytes as latin1; undo that so 中文文件名 survive.
 *  Pick only when a char sits in 0x80..0xFF (a latin1-decoded byte), else assume already UTF-8. */
function decodeOriginalName(name: string): string {
  const hasLatin1Byte = name.split("").some((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp > 0x7f && cp < 0x100;
  });
  return hasLatin1Byte ? Buffer.from(name, "latin1").toString("utf8") : name;
}

function busyError(task: TaskRow): string | null {
  if (task.status === "segmenting") return "任务正在分段中";
  if (task.status === "running") return "任务正在运行中";
  return null;
}

/** 合成类接口：运行中允许排队，仅分段中拒绝。 */
function segmentingError(task: TaskRow): string | null {
  if (task.status === "segmenting") return "任务正在分段中";
  return null;
}

function logPhonetic(
  taskId: number,
  key: string,
  input: string,
  output: string,
  operation: "自动注音" | "批量注音"
): void {
  logger.info(
    `🔤 ${operation} task=${taskId} key=${key} input=${JSON.stringify(input)} output=${JSON.stringify(output)}`
  );
  // 记录「注音」步骤：输入与注音结果
  segmentLogService.logStep(taskId, key, "phonetic", { operation, input, output });
}

tasksRouter.post("/", upload.fields([{ name: "file", maxCount: 1 }, { name: "name" }, { name: "overwrite" }]), (req: Request, res: Response) => {
  try {
    const body = (req as any).body || {};
    const name = String(body.name || "任务").trim();
    const overwrite = parseBooleanFlag(body, "overwrite") ?? false;

    if (taskService.exists(name) && !overwrite) {
      res.status(409).json({ error: "同名任务已存在", exists: true, name });
      return;
    }
    // remove conflicting record+files when overwriting
    if (overwrite && taskService.exists(name)) {
      const old = taskService.list().find((t) => t.name === name);
      if (old) taskService.remove(old.id);
    }

    const id = taskService.create({
      name,
      model_id: Number(body.model_id) || undefined,
      params_json: readJson(body, "params_json"),
      skip_tts: parseBooleanFlag(body, "skip_tts") ?? false,
    });

    const files = (req as any).files?.file;
    const file = Array.isArray(files) ? files[0] : files;
    if (file) {
      taskService.saveUpload(id, decodeOriginalName(file.originalname), file.buffer);
    }
    void prepareTask(id).catch((e) => {
      logger.error(`❌ 任务后台分段异常: ${(e as Error).message}`);
    });
    res.status(201).json({ id, name, status: "segmenting" });
  } catch (e) {
    logger.error(`❌ 创建任务失败: ${(e as Error).message}`);
    sendError(res, 400, e);
  }
});

tasksRouter.get("/:id", (req: Request, res: Response) => {
  const task = taskService.get(Number(req.params.id));
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json(withUploadName({ ...task, files: taskService.listOutput(task.id) }));
});

tasksRouter.put("/:id", upload.fields([{ name: "file", maxCount: 1 }]), (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const body = (req as any).body || {};
  const patch: Partial<TaskRow> = {};
  if ("name" in body) {
    const newName = String(body.name).trim();
    if (newName && newName !== task.name && taskService.exists(newName)) {
      res.status(409).json({ error: "同名任务已存在", exists: true });
      return;
    }
    if (newName) patch.name = newName;
  }
  if ("model_id" in body) patch.model_id = Number(body.model_id) || task.model_id;
  if ("params_json" in body) patch.params_json = readJson(body, "params_json", task.params_json);
  if ("skip_tts" in body) patch.skip_tts = Number(parseBooleanFlag(body, "skip_tts"));
  taskService.update(id, patch);

  const files = (req as any).files?.file;
  const file = Array.isArray(files) ? files[0] : files;
  if (file) taskService.saveUpload(id, decodeOriginalName(file.originalname), file.buffer);

  logger.success(`✅ 任务已更新: id=${id}`);
  res.json({ ok: true });
});

tasksRouter.delete("/:id", (req: Request, res: Response) => {
  taskService.remove(Number(req.params.id));
  res.json({ ok: true });
});

tasksRouter.post("/:id/prepare", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const busy = busyError(task);
  if (busy) {
    res.status(409).json({ error: busy });
    return;
  }

  // 分段尺寸等参数来自任务设置（新建/编辑任务时已保存）；重新分段不再接受覆盖，
  // 也不修改「跳过语音合成」——分段是合成前的文字预处理。
  const maxChars = segmentMaxChars(parseJsonObject(task.params_json));
  void prepareTask(id).catch((e) => {
    logger.error(`❌ 任务后台分段异常: ${(e as Error).message}`);
  });
  res.status(202).json({
    ok: true,
    message: "任务分段已开始",
    steps: [
      `按设置的分段长度重新分段（${maxChars} 字/段）`,
      "保留已有语音文件，仅复用内容一致的分段，其余需重新合成",
      "重新抽取文档文本",
      "写出 intermediate.json",
    ],
  });
});

tasksRouter.post("/:id/run", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const busy = segmentingError(task);
  if (busy) {
    res.status(409).json({ error: busy });
    return;
  }
  if (!taskService.readIntermediate(id)) {
    res.status(409).json({ error: "中间文件不存在，请先运行任务" });
    return;
  }

  void runTask(id, { username: req.auth?.username, skipExisting: parseBooleanFlag((req as any).body || {}, "skipExisting") ?? false }).catch((e) => {
    logger.error(`❌ 任务后台 TTS 异常: ${(e as Error).message}`);
  });
  res.status(202).json({ ok: true, message: "语音合成已开始" });
});

tasksRouter.post("/:id/tts", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

  const rawKeys = (req as any).body?.keys;
  if (rawKeys !== undefined && (!Array.isArray(rawKeys) || !rawKeys.every((key) => typeof key === "string"))) {
    res.status(400).json({ error: "keys 必须是字符串数组" });
    return;
  }
  const busy = segmentingError(task);
  if (busy) {
    res.status(409).json({ error: busy });
    return;
  }
  const body = taskService.readIntermediate(id);
  if (!body) {
    res.status(409).json({ error: "中间文件不存在，请先运行任务" });
    return;
  }
  if (rawKeys !== undefined && rawKeys.length === 0) {
    res.status(400).json({ error: "keys 不能为空" });
    return;
  }
  try {
    selectTtsKeys(body, rawKeys);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }

  const skipExisting = parseBooleanFlag((req as any).body || {}, "skipExisting") ?? false;
  void synthesizeTask(id, rawKeys, { username: req.auth?.username, skipExisting }).catch((e) => {
    logger.error(`❌ 任务后台 TTS 异常: ${(e as Error).message}`);
  });
  res.status(202).json({ ok: true, message: "语音合成已开始" });
});

tasksRouter.post("/:id/stop", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  requestStop(id);
  res.json({ ok: true, message: "已请求停止" });
});

tasksRouter.post("/:id/pause", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  requestPause(id);
  res.json({ ok: true, message: "已请求暂停" });
});

tasksRouter.post("/:id/resume", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const busy = segmentingError(task);
  if (busy) {
    res.status(409).json({ error: busy });
    return;
  }
  const body = taskService.readIntermediate(id);
  if (!body) {
    res.status(409).json({ error: "中间文件不存在，请先运行任务" });
    return;
  }
  void resumeTask(id, { username: req.auth?.username }).catch((e) => {
    logger.error(`❌ 任务后台恢复异常: ${(e as Error).message}`);
  });
  res.status(202).json({ ok: true, message: "已继续合成" });
});

tasksRouter.post("/:id/phonetic", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

  const rawBody = (req as any).body;
  if (rawBody !== undefined && rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
    res.status(400).json({ error: "请求体格式错误" });
    return;
  }
  const rawKeys = rawBody?.keys;
  if (rawKeys !== undefined && (!Array.isArray(rawKeys) || !rawKeys.every((key: unknown) => typeof key === "string"))) {
    res.status(400).json({ error: "keys 必须是字符串数组" });
    return;
  }

  const busy = busyError(task);
  if (busy) {
    res.status(409).json({ error: busy });
    return;
  }
  const body = taskService.readIntermediate(id);
  if (!body) {
    res.status(409).json({ error: "中间文件不存在，请先运行任务" });
    return;
  }
  if (rawKeys !== undefined && rawKeys.length === 0) {
    res.status(400).json({ error: "keys 不能为空" });
    return;
  }

  try {
    const keys = selectTtsKeys(body, rawKeys);
    resetTextRulesTrace();
    logger.info(`[phonetic] 批量注音 task=${id} 分段数=${keys.length}`);
    const enhance = {
      ...enhanceOptionsFromParams(parseJsonObject(task.params_json)),
      entities: namedEntityService.replacementRules(),
    };
    const updates = keys.map((key) => {
      const text = enhanceText(body.segments[key].text, enhance);
      const phonetic = xmlize(text);
      logPhonetic(id, key, text, phonetic, "批量注音");
      return { key, text, phonetic };
    });
    taskService.updateSegmentsPhonetic(id, updates);
    res.json({ ok: true, updated: keys.length, keys });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`❌ 批量注音失败: task=${id} error=${message}`);
    res.status(400).json({ error: message });
  }
});

tasksRouter.get("/:id/status", (req: Request, res: Response) => {
  const task = taskService.get(Number(req.params.id));
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({
    id: task.id,
    name: task.name,
    status: task.status,
    progress: task.progress,
    segment_count: task.segment_count,
    error: task.error,
    files: taskService.listOutput(task.id),
    skip_tts: Boolean(task.skip_tts),
    error_count: errorService.count(task.id),
  });
});

/** 任务错误历史（重试耗尽后记录），供工作界面右上角查看/清除。 */
tasksRouter.get("/:id/errors", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!taskService.get(id)) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({ errors: errorService.list(id) });
});

tasksRouter.delete("/:id/errors", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!taskService.get(id)) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({ ok: true, cleared: errorService.clear(id) });
});

/** 服务端权威的「分段 → 当前音频文件名」映射（只有 key+内容 hash 都匹配的才算）。 */
tasksRouter.get("/:id/audio-map", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!taskService.get(id)) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({ audio: taskService.audioNameMap(id) });
});

tasksRouter.get("/:id/files/:name", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const name = path.basename(String(req.params.name));
  const found = taskService.readTaskFile(id, name);
  if (!found) {
    res.status(404).json({ error: "文件不存在" });
    return;
  }
  res.download(found.path, found.name);
});

tasksRouter.get("/:id/output/last", (req: Request, res: Response) => {
  const files = taskService.listOutput(Number(req.params.id));
  res.json({ files });
});

// ---------- segment working interface ----------

/** Lightweight task info: chapter labels + counts. Fast even for many-thousand segments. */
tasksRouter.get("/:id/info", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const data = taskService.readIntermediate(id);
  const maxChars = segmentMaxChars(parseJsonObject(task.params_json));
  if (!data) {
    res.json({
      status: task.status,
      progress: task.progress,
      error: task.error,
      text: "",
      sources: [],
      segmentCount: 0,
      maxChars,
    });
    return;
  }
  res.json({
    status: task.status,
    progress: task.progress,
    error: task.error,
    text: data.text,
    sources: data.sources,
    segmentCount: Object.keys(data.segments).length,
    maxChars,
  });
});

/**
 * Segments. Full list when no query params; otherwise paginated per chapter:
 *   GET /:id/segments?source=<chapter>&offset=<n>&limit=<m>
 * Use /:id/info first to get chapter labels, then fetch each chapter lazily.
 */
tasksRouter.get("/:id/segments", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const data = taskService.readIntermediate(id);
  if (!data) {
    res.status(404).json({ error: "中间文件不存在，请先运行任务" });
    return;
  }

  const source = (req.query as any).source;
  const hasPage =
    source !== undefined ||
    (req.query as any).offset !== undefined ||
    (req.query as any).limit !== undefined;

  // per-chapter mode. A chapter is always returned in full (no segment cap) so
  // the working interface never has to page; `offset`/`limit` remain optional
  // and only apply when explicitly supplied.
  if (hasPage) {
    const src = String(source ?? "");
    const offset = Math.max(0, Number((req.query as any).offset) || 0);
    const rawLimit = Number((req.query as any).limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : Number.MAX_SAFE_INTEGER;
    res.json(taskService.readSegmentsPage(id, src, offset, limit));
    return;
  }

  // full list (back-compat)
  const segments = Object.entries(data.segments).map(([key, seg]) => ({
    key,
    text: seg.text,
    phonetic: seg.phonetic || "",
    source: seg.source || "",
    audio: (() => {
      const p = taskService.segmentAudioPath(id, key);
      return p ? path.basename(p) : null;
    })(),
  }));
  res.json({ text: data.text, sources: data.sources, segments });
});

tasksRouter.put("/:id/segments/:key", (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const key = String(req.params.key);
    const body = (req as any).body || {};
    const patch: { text?: string; phonetic?: string } = {};
    if (typeof body.text === "string") patch.text = body.text;
    if (typeof body.phonetic === "string") patch.phonetic = body.phonetic;
    if (!Object.keys(patch).length) {
      res.status(400).json({ error: "没有可更新的字段" });
      return;
    }
    const seg = taskService.updateSegment(id, key, patch);
    res.json({ ok: true, segment: { key, ...seg } });
  } catch (e) {
    sendError(res, 400, e);
  }
});

tasksRouter.post("/:id/search", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

  const raw = ((req as any).body || {}) as Record<string, unknown>;
  const query = typeof raw.query === "string" ? raw.query : "";
  const markFilter =
    raw.mark === "like" || raw.mark === "dislike" ? (raw.mark as "like" | "dislike") : null;
  // 允许「只按标记类型筛选」而无需输入搜索词
  if (!query && !markFilter) {
    res.status(400).json({ error: "query 不能为空" });
    return;
  }
  const caseSensitive = raw.caseSensitive === true;
  const wildcard = raw.wildcard === true;

  let test: (text: string) => boolean;
  if (!query) {
    test = () => true;
  } else if (wildcard) {
    let re: RegExp;
    try {
      re = new RegExp(query, caseSensitive ? "" : "i");
    } catch {
      res.status(400).json({ error: "通配符（正则）表达式无效" });
      return;
    }
    test = (text) => re.test(text);
  } else if (caseSensitive) {
    test = (text) => text.includes(query);
  } else {
    const lowered = query.toLowerCase();
    test = (text) => text.toLowerCase().includes(lowered);
  }

  const intermediate = taskService.readIntermediate(id);
  if (!intermediate) {
    res.status(409).json({ error: "中间文件不存在，请先运行任务" });
    return;
  }

  // Object key 顺序即文档顺序；只返回 key/source 供前端定位。
  const marked = markFilter ? segmentLogService.markedKeys(id, markFilter) : null;
  const results = Object.entries(intermediate.segments)
    .filter(([key, seg]) => test(seg.text) && (!marked || marked.has(key)))
    .map(([key, seg]) => ({ key, source: seg.source || "" }));

  res.json({ total: results.length, results });
});

/** 任务下全部标记：key → { mark, feedback }。 */
tasksRouter.get("/:id/marks", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!taskService.get(id)) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({ marks: segmentLogService.listMarks(id) });
});

/** 设置/取消分段标记（点赞/点踩，点踩可附反馈，反馈可为空）。 */
tasksRouter.put("/:id/segments/:key/mark", (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const key = String(req.params.key);
    if (!taskService.get(id)) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    const body = ((req as any).body || {}) as Record<string, unknown>;
    const rawMark = body.mark;
    if (rawMark !== null && rawMark !== "like" && rawMark !== "dislike") {
      res.status(400).json({ error: "mark 仅支持 like / dislike / null" });
      return;
    }
    segmentLogService.setMark(id, key, rawMark, typeof body.feedback === "string" ? body.feedback : "");
    res.json({ ok: true, marks: segmentLogService.listMarks(id) });
  } catch (e) {
    sendError(res, 400, e);
  }
});

/** 某个分段的步骤记录（分段/注音/合成），按时间正序。 */
tasksRouter.get("/:id/segments/:key/steps", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const key = String(req.params.key);
  if (!taskService.get(id)) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({ steps: segmentLogService.listSteps(id, key) });
});

tasksRouter.post("/:id/segments/:key/auto-phonetic", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const key = String(req.params.key);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }

  const segment = taskService.getSegment(id, key);
  if (!segment) {
    res.status(404).json({ error: "段落不存在" });
    return;
  }

  const rawText = (req as any).body?.text;
  if (typeof rawText !== "string") {
    res.status(400).json({ error: "text 必须是字符串" });
    return;
  }

  resetTextRulesTrace();
  logger.info(`[phonetic] 自动注音 task=${id} key=${key}`);
  const enhance = {
    ...enhanceOptionsFromParams(parseJsonObject(task.params_json)),
    entities: namedEntityService.replacementRules(),
  };
  const text = enhanceText(rawText, enhance);
  const phonetic = xmlize(text);
  logPhonetic(id, key, text, phonetic, "自动注音");
  res.json({ text, phonetic });
});

/** 仅返回 jieba 的分词结果（不含拼音），用于界面「分词文本」视图。 */
tasksRouter.post("/:id/segments/:key/segment", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const key = String(req.params.key);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const segment = taskService.getSegment(id, key);
  if (!segment) {
    res.status(404).json({ error: "段落不存在" });
    return;
  }
  const text = (req as any).body?.text;
  if (typeof text !== "string") {
    res.status(400).json({ error: "text 必须是字符串" });
    return;
  }
  res.json({ text, words: segmentText(text) });
});

tasksRouter.post("/:id/segments/:key/synthesize", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const key = String(req.params.key);
    await synthesizeSegment(id, key);
    const audioPath = taskService.segmentAudioPath(id, key);
    res.json({ ok: true, audio: audioPath ? path.basename(audioPath) : null });
  } catch (e) {
    sendError(res, 400, e);
  }
});

/** 导出音频：每章 / 选中分段，mp3|wav（合并）或 zip（打包分段音频）。 */
tasksRouter.post("/:id/export", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const scope = String((req as any).body?.scope || "chapters");
    const format = String((req as any).body?.format || "wav").toLowerCase();
    if (scope !== "chapters" && scope !== "selected") {
      res.status(400).json({ error: "scope 仅支持 chapters / selected" });
      return;
    }
    if (!["mp3", "wav", "zip"].includes(format)) {
      res.status(400).json({ error: "导出格式仅支持 mp3 / wav / zip" });
      return;
    }
    const keys = Array.isArray((req as any).body?.keys)
      ? ((req as any).body.keys.map(String) as string[])
      : undefined;
    const result = await buildExport(id, { scope, format: format as ExportFormat, keys });
    res.setHeader("Content-Type", result.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`
    );
    res.send(result.buffer);
  } catch (e) {
    sendError(res, 400, e);
  }
});

/** 创建后台导出任务（低优先级；进度见 /api/jobs）。 */
tasksRouter.post("/:id/export-jobs", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const scope = String((req as any).body?.scope || "chapters");
  const format = String((req as any).body?.format || "wav").toLowerCase();
  if (scope !== "chapters" && scope !== "selected") {
    res.status(400).json({ error: "scope 仅支持 chapters / selected" });
    return;
  }
  if (!["mp3", "wav", "zip"].includes(format)) {
    res.status(400).json({ error: "导出格式仅支持 mp3 / wav / zip" });
    return;
  }
  const keys = Array.isArray((req as any).body?.keys)
    ? ((req as any).body.keys.map(String) as string[])
    : undefined;

  const job = jobService.create("export", id, task.name);
  const filename = exportFilename(task.name, scope as ExportScope, format as ExportFormat);
  const destPath = path.join(jobDir(job.id), filename);
  jobService.run(job.id, async (ctx) => {
    await exportToFile(
      id,
      { scope: scope as ExportScope, format: format as ExportFormat, keys },
      destPath,
      ctx.report,
      yieldLoop
    );
    return { resultPath: destPath, resultName: filename };
  });
  res.json({ jobId: job.id });
});

/** 创建后台清理任务：unused=删除非最新旧副本；all=删除该任务全部分段音频。 */
tasksRouter.post("/:id/cleanup-jobs", requireAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const task = taskService.get(id);
  if (!task) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const mode = String((req as any).body?.mode || "unused");
  if (mode !== "unused" && mode !== "all") {
    res.status(400).json({ error: "mode 仅支持 unused / all" });
    return;
  }
  const job = jobService.create("cleanup", id, task.name);
  jobService.run(job.id, async (ctx) => {
    await cleanupTaskAudio(id, mode, ctx, yieldLoop);
  });
  res.json({ jobId: job.id });
});

/** 搜索历史：每个任务最多保留最近 100 条。 */
tasksRouter.get("/:id/search-history", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!taskService.get(id)) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({ items: searchHistoryService.list(id), max: MAX_HISTORY_ITEMS });
});

tasksRouter.post("/:id/search-history", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!taskService.get(id)) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  try {
    const items = searchHistoryService.record(id, (req as any).body || {});
    res.json({ items, max: MAX_HISTORY_ITEMS });
  } catch (e) {
    sendError(res, 400, e);
  }
});

tasksRouter.delete("/:id/search-history/:historyId", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const historyId = Number(req.params.historyId);
  if (!taskService.get(id)) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  searchHistoryService.remove(id, historyId);
  res.json({ items: searchHistoryService.list(id), max: MAX_HISTORY_ITEMS });
});