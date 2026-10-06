import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { extractText } from "./documentService";
import { phoneticXmlToInput } from "./phonetic";
import { enhanceOptionsFromParams, type TextEnhanceOptions } from "./textEnhance";
import { buildAudioFileName, segmentContentHash } from "./audioFiles";
import { withRetry } from "./retry";
import { errorService } from "./errorService";
import { segmentLogService } from "./segmentLogService";
import { namedEntityService } from "./namedEntityService";
import { resetTextRulesTrace } from "./textRules";
import { getErrorMessage } from "../shared/errors";
import { buildIntermediateBody, buildSegments, sortSegmentKeys, type SegmentEntry } from "./segmentBuilder";
import { synthesizeText, buildPayload, audioToDataUrl, type TtsModelRef } from "./ttsClient";
import { modelService, parseParamSchema } from "./modelService";
import { voiceService } from "./voiceService";
import {
  taskService,
  taskDir,
  uploadedFilePath,
  intermediateJsonPath,
  type IntermediateBody,
  type TaskRow,
} from "./taskService";
import { DEFAULT_MAX_CHARS_PER_SEGMENT, TTS_DEFAULT_API_KEY } from "../config";
import { formatLogData, logger } from "../logger";

export function segmentMaxChars(params: Record<string, unknown>): number {
  const raw = params?.segment_max_chars ?? params?.max_chars_per_segment;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MAX_CHARS_PER_SEGMENT;
}

function emitIntermediate(id: number, text: string, segments: SegmentEntry[]): void {
  const body: IntermediateBody = buildIntermediateBody(text, segments);
  fs.writeFileSync(intermediateJsonPath(id), JSON.stringify(body, null, 2), "utf8");
}

/** Locate the compiled worker (prod) or its TS source (tsx dev). */
function segmentWorkerPath(): string | null {
  const candidates = [
    path.join(__dirname, "segmentWorker.js"),
    path.join(__dirname, "segmentWorker.ts"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Run extraction + segmentation on a worker thread so the HTTP event loop is
 * not blocked. Resolves with the segment count once intermediate.json is written.
 */
function runSegmentationWorker(input: {
  taskId: number;
  filePath: string;
  phoneticEnabled: boolean;
  maxChars: number;
  start: number;
  end: number;
  enhance: TextEnhanceOptions;
}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const workerPath = segmentWorkerPath();
    if (!workerPath) {
      reject(new Error("未找到 segmentWorker（请先构建 server）"));
      return;
    }

    const worker = new Worker(workerPath, {
      workerData: input,
      // dev(tsx) 下 worker 是 .ts，需要用 tsx 加载器；生产为编译后的 .js。
      execArgv: workerPath.endsWith(".ts") ? ["--import", "tsx"] : process.execArgv,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };

    worker.on("message", (msg: any) => {
      if (msg?.type === "step") {
        logger.info(`      · ${msg.step}`);
        if (typeof msg.progress === "number") {
          taskService.setStatus(input.taskId, "segmenting", {
            progress: Math.min(99, Math.max(0, msg.progress)),
          });
        }
      } else if (msg?.type === "done") {
        finish(() => resolve(Number(msg.segmentCount) || 0));
      } else if (msg?.type === "error") {
        finish(() => reject(new Error(String(msg.message))));
      }
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error(`分段 worker 异常退出 (code=${code})`)));
    });
  });
}

function refAudioDataUrl(params: Record<string, unknown>): string | undefined {
  const voiceId = Number(params.voice_file_id);
  if (params.ref_audio && typeof params.ref_audio === "string") return params.ref_audio;
  if (voiceId) {
    const buf = voiceService.readBuffer(voiceId);
    if (buf) return audioToDataUrl(buf);
  }
  return undefined;
}

function refAudioSourceForLog(params: Record<string, unknown>): string {
  const refAudio = params.ref_audio;
  if (typeof refAudio === "string" && refAudio.trim()) {
    return /^data:/i.test(refAudio.trim()) ? "embedded audio data" : `data in ${refAudio}`;
  }

  const voiceId = Number(params.voice_file_id);
  if (Number.isInteger(voiceId) && voiceId > 0) {
    const voice = voiceService.get(voiceId);
    if (voice) return `data in ${voice.file_name} (voice_file_id=${voiceId})`;
    return `voice_file_id=${voiceId}`;
  }

  return "embedded audio data";
}

const modelDefaultsCache = new Map<string, Record<string, unknown>>();

function modelParameterDefaults(schemaYaml: string): Record<string, unknown> {
  const cached = modelDefaultsCache.get(schemaYaml);
  if (cached) return cached;

  try {
    const schema = parseParamSchema(schemaYaml);
    const defaults: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.params)) {
      if (field && Object.prototype.hasOwnProperty.call(field, "default")) {
        defaults[key] = field.default;
      }
    }
    modelDefaultsCache.set(schemaYaml, defaults);
    return defaults;
  } catch {
    return {};
  }
}

/** In-memory stop/pause flags for running synthesis (per process). */
const stoppedTasks = new Set<number>();
const pausedTasks = new Set<number>();
const taskAborters = new Map<number, AbortController>();

/** Request to stop a running synthesis; aborts the in-flight TTS request. */
export function requestStop(taskId: number): void {
  stoppedTasks.add(taskId);
  taskAborters.get(taskId)?.abort();
}

/** Request to pause a running synthesis; aborts the in-flight TTS request. */
export function requestPause(taskId: number): void {
  pausedTasks.add(taskId);
  taskAborters.get(taskId)?.abort();
}

function beginRun(taskId: number): AbortController {
  stoppedTasks.delete(taskId);
  pausedTasks.delete(taskId);
  const controller = new AbortController();
  taskAborters.set(taskId, controller);
  return controller;
}

function endRun(taskId: number): void {
  stoppedTasks.delete(taskId);
  pausedTasks.delete(taskId);
  taskAborters.delete(taskId);
}

function wasStopped(taskId: number): boolean {
  return stoppedTasks.has(taskId);
}

function wasPaused(taskId: number): boolean {
  return pausedTasks.has(taskId);
}

function isStopError(error: unknown): boolean {
  return error instanceof Error && error.name === "TaskStopped";
}

/**
 * Synthesize one segment and write `<key>-<内容hash>.wav` into the task dir.
 * TTS input is the phonetic-annotated text when present (port of _tts_input).
 */
async function synthesizeOne(
  task: TaskRow,
  seg: SegmentEntry,
  key: string,
  signal?: AbortSignal
): Promise<void> {
  const model = task.model_id ? modelService.get(task.model_id) : undefined;
  if (!model) throw new Error("任务未关联 TTS 模型，无法合成");
  const params = safeJson(task.params_json);
  const modelRef: TtsModelRef = {
    name: model.name,
    apiUrl: model.api_url,
    apiPath: model.api_path,
    // The API key comes from the model settings (or the built-in default); a
    // per-task api_key must never override it (it caused stale/wrong keys).
    apiKey: String(model.api_key || TTS_DEFAULT_API_KEY || ""),
    parameterDefaults: modelParameterDefaults(model.parameters_schema_yaml),
  };
  // TTS input: 分段文本已含 IndexTTS 文字增强（分段/注音时写入），这里只做注音 XML → <字|拼音>，无注音时退回原文。
  const input = phoneticXmlToInput(seg.text, seg.phonetic || "");
  const payload = buildPayload(input, modelRef, params, refAudioDataUrl(params));
  const logPayload = { ...payload };
  if (Object.prototype.hasOwnProperty.call(logPayload, "ref_audio")) {
    logPayload.ref_audio = refAudioSourceForLog(params);
  }
  const hash = segmentContentHash(seg);
  const audioPath = path.join(taskDir(task.id), buildAudioFileName(key, hash, "wav"));
  logger.info(`🎙️ [${key}] ${seg.text.slice(0, 60)}`);
  logger.info(
    `🧾 语音合成 payload task=${task.id} key=${key}:\n${formatLogData(logPayload)}`
  );
  const startedAt = Date.now();
  try {
    const { audio, status } = await withRetry(
      () =>
        synthesizeText({
          apiUrl: model.api_url,
          apiPath: model.api_path,
          apiKey: modelRef.apiKey,
          payload,
          signal,
        }),
      { signal, label: `[${key}] 语音合成` },
    );
    fs.writeFileSync(audioPath, audio);
    // 记录「合成」步骤：送出的文本、耗时、HTTP 状态
    segmentLogService.logStep(
      task.id,
      key,
      "synthesize",
      { input, bytes: audio.length },
      { status, durationMs: Date.now() - startedAt },
    );
  } catch (error) {
    // 记录「合成」步骤（失败）：送出的文本、耗时、状态码（如有）、报错信息
    segmentLogService.logStep(
      task.id,
      key,
      "synthesize",
      { input },
      {
        status: (error as { status?: number })?.status ?? null,
        durationMs: Date.now() - startedAt,
        error: getErrorMessage(error),
      },
    );
    throw error;
  }
}

function ensureTask(taskId: number): TaskRow {
  const task = taskService.get(taskId);
  if (!task) throw new Error("任务不存在");
  return task;
}

function ensureNotBusy(task: TaskRow): void {
  if (task.status === "segmenting") throw new Error("任务正在分段中");
  if (task.status === "running") throw new Error("任务正在运行中");
}

/** 合成只禁止在分段进行时进入；运行中的合成请求改为排队串行执行。 */
function ensureNotSegmenting(task: TaskRow): void {
  if (task.status === "segmenting") throw new Error("任务正在分段中");
}

function ensureIntermediate(taskId: number): IntermediateBody {
  const body = taskService.readIntermediate(taskId);
  if (!body) throw new Error("中间文件不存在，请先运行任务");
  return body;
}

export function taskProgress(keys: string[], audioKeys: ReadonlySet<string>): number {
  if (!keys.length) return 0;
  let ready = 0;
  for (const key of keys) {
    if (audioKeys.has(key)) ready += 1;
  }
  return Math.round((ready / keys.length) * 100);
}

export function selectTtsKeys(
  body: Pick<IntermediateBody, "segments">,
  requested?: string[]
): string[] {
  const keys = sortSegmentKeys(Object.keys(body.segments));
  if (requested === undefined) return keys;

  const keySet = new Set(keys);
  const requestedSet = new Set<string>();
  for (const rawKey of requested) {
    const key = String(rawKey);
    if (!keySet.has(key)) throw new Error(`段落 ${key} 不存在`);
    requestedSet.add(key);
  }

  return keys.filter((key) => requestedSet.has(key));
}

export function allAudioReady(keys: string[], audioKeys: ReadonlySet<string>): boolean {
  return keys.every((key) => audioKeys.has(key));
}

/** Extract and segment the uploaded document, writing intermediate.json only. */
export async function prepareTask(taskId: number): Promise<void> {
  const task = ensureTask(taskId);
  ensureNotBusy(task);

  taskService.setStatus(taskId, "segmenting", { progress: 0, error: null, segment_count: 0 });
  logger.info(`🚧 开始准备任务 ${taskId} (${task.name})`);
  resetTextRulesTrace();

  const params = safeJson(task.params_json);
  const phoneticEnabled = Boolean(params.phonetic);
  const maxChars = segmentMaxChars(params);
  const enhance = {
    ...enhanceOptionsFromParams(params),
    entities: namedEntityService.replacementRules(),
  };

  try {
    logger.info(`  [步骤 1/6] 清除旧的分段结果（保留音频，稍后按内容 hash 复用）`);
    taskService.clearIntermediate(taskId);

    const filePath = uploadedFilePath(taskId);
    if (!filePath) throw new Error("任务没有上传文档");

    const start = Number(params.epub_start) || 1;
    const end = Number(params.epub_end) || -1;

    // Heavy work runs on a worker thread so this process keeps serving requests.
    let segmentCount: number;
    try {
      logger.info(`  [步骤 2/6] 在后台线程抽取并分段 (不阻塞其他请求)`);
      segmentCount = await runSegmentationWorker({
        taskId,
        filePath,
        phoneticEnabled,
        maxChars,
        start,
        end,
        enhance,
      });
      logger.info(`  [步骤 6/6] 中间文件已写出: intermediate.json`);
    } catch (workerError) {
      const reason = workerError instanceof Error ? workerError.message : String(workerError);
      logger.warn(`⚠️  后台分段线程不可用，回退主线程同步分段: ${reason}`);
      const extracted = await extractText(filePath, { start, end });
      logger.info(
        `  [步骤 4/6] 抽取完成: ${extracted.text.length} 字, ${extracted.sourceLabels.length} 个源`
      );
      const segments = buildSegments(extracted, phoneticEnabled, maxChars, enhance);
      logger.info(`  [步骤 5/6] 分段完成: 共 ${segments.length} 段`);
      emitIntermediate(taskId, extracted.text, segments);
      logger.info(`  [步骤 6/6] 写出中间文件: intermediate.json`);
      segmentCount = segments.length;
    }

    const relinked = taskService.relinkAudioByContent(taskId);
    if (relinked) logger.info(`  ♻️  按内容 hash 复用旧语音 ${relinked} 段`);

    // 记录「分段」步骤：每段长度（时间由后端记录）
    const prepared = taskService.readIntermediate(taskId);
    if (prepared) {
      const entries = Object.entries(prepared.segments);
      segmentLogService.logSteps(
        entries.map(([key, seg]) => ({
          taskId,
          key,
          step: "segment" as const,
          detail: { length: seg.text.length, source: seg.source ?? "" },
        })),
      );
      logger.info(`  📝 已记录 ${entries.length} 段的「分段」步骤`);
    }

    taskService.setStatus(taskId, "ready", {
      progress: 100,
      error: null,
      segment_count: segmentCount,
    });
    logger.success(`✅ 任务 ${taskId} 准备完成 (${segmentCount} 段)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`❌ 任务 ${taskId} 准备失败: ${message}`);
    errorService.record(taskId, "prepare", message);
    taskService.setStatus(taskId, "error", { error: message });
    throw error;
  }
}

/** Synthesize all or selected segments from an existing intermediate.json. */
export async function synthesizeTask(
  taskId: number,
  requestedKeys?: string[],
  opts?: { uid?: number; username?: string; skipExisting?: boolean }
): Promise<void> {
  const task = ensureTask(taskId);
  ensureNotSegmenting(task);

  const body = ensureIntermediate(taskId);
  const allKeys = taskService.segmentKeys(taskId);
  const requested = selectTtsKeys(body, requestedKeys);
  // 「跳过已合成」：内容匹配的音频已存在则跳过该分段。
  const ready = opts?.skipExisting ? taskService.audioKeys(taskId) : null;
  const keys = ready ? requested.filter((key) => !ready.has(key)) : requested;

  if (Boolean(task.skip_tts)) {
    taskService.setStatus(taskId, "done", {
      progress: 100,
      error: null,
      segment_count: allKeys.length,
    });
    logger.success(`✅ 任务 ${taskId} 完成 (skipTts)`);
    return;
  }

  if (!keys.length) {
    const readyAudio = taskService.audioKeys(taskId);
    const done = allAudioReady(allKeys, readyAudio);
    taskService.setStatus(taskId, done ? "done" : "ready", {
      progress: done ? 100 : taskProgress(allKeys, readyAudio),
      error: null,
      segment_count: allKeys.length,
    });
    return;
  }

  const who = opts?.username || "后台";
  logger.info(`🚀 任务 ${taskId} 入队 ${keys.length} 段合成 by ${who}`);
  await enqueueSynthesis(taskId, keys);
}

/** Compatibility entry for full-document synthesis after preparation has completed. */
export async function runTask(
  taskId: number,
  opts?: { uid?: number; username?: string; skipExisting?: boolean }
): Promise<void> {
  await synthesizeTask(taskId, undefined, opts);
}

/** Resume a paused task: synthesize only the segments that still lack audio. */
export async function resumeTask(
  taskId: number,
  opts?: { uid?: number; username?: string }
): Promise<void> {
  ensureTask(taskId);
  ensureIntermediate(taskId);
  const allKeys = taskService.segmentKeys(taskId);
  const audio = taskService.audioKeys(taskId);
  const missing = allKeys.filter((key) => !audio.has(key));
  if (!missing.length) {
    const done = allAudioReady(allKeys, audio);
    taskService.setStatus(taskId, done ? "done" : "ready", {
      progress: done ? 100 : taskProgress(allKeys, audio),
      error: null,
      segment_count: allKeys.length,
    });
    return;
  }
  await synthesizeTask(taskId, missing, opts);
}

/** Re-synthesize a single segment (regenerate voice for edited text/phonetic). */
export async function synthesizeSegment(taskId: number, key: string): Promise<void> {
  const task = ensureTask(taskId);
  ensureNotSegmenting(task);

  const body = ensureIntermediate(taskId);
  if (!body.segments[key]) throw new Error(`段落 ${key} 不存在`);

  await enqueueSynthesis(taskId, [key]);
}

// ============================== 合成队列 ==============================
//
// 每次“重新合成 / 批量合成”创建一个子队列（job），按**轮转**顺序从各子队列
// 依次取一段串行执行，例如 A(10)、B(3)、C(1) 三个子队列：
//   A1,B1,C1,A2,B2,A3,B3,A4,...
// 新加入的子队列排在末尾并纳入后续轮转；若执行到 B1 时新增 D，
// 之后顺序为 …B1,C1,D1,A2,B2,… 运行中的请求不再被拒绝，而是入队等待。

interface QueueJob {
  keys: string[];
  settled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface TaskQueueState {
  jobs: QueueJob[];
  cursor: number;
  running: boolean;
}

const taskQueues = new Map<number, TaskQueueState>();

function settleJob(job: QueueJob, error?: unknown): void {
  if (job.settled) return;
  job.settled = true;
  if (error === undefined) job.resolve();
  else job.reject(error);
}

/**
 * 轮转取下一个待合成段落：从 cursor 起找第一个非空子队列。
 * cursor 记录绝对的“下一个下标”（不按当前数量取模），这样在其后新增子队列时，
 * 新队列能被纳入本轮轮转；取模只在扫描开始时归一化。
 */
function takeNext(state: TaskQueueState): { job: QueueJob; key: string } | null {
  const count = state.jobs.length;
  if (!count) return null;
  const start = state.cursor % count;
  for (let step = 0; step < count; step++) {
    const index = (start + step) % count;
    const job = state.jobs[index];
    if (job.keys.length) {
      const key = job.keys.shift() as string;
      state.cursor = index + 1;
      return { job, key };
    }
  }
  return null;
}

function enqueueSynthesis(taskId: number, keys: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let state = taskQueues.get(taskId);
    if (!state) {
      state = { jobs: [], cursor: 0, running: false };
      taskQueues.set(taskId, state);
    }
    state.jobs.push({ keys: [...keys], settled: false, resolve, reject });
    if (!state.running) {
      state.running = true;
      void processQueue(taskId, state);
    }
  });
}

async function processQueue(taskId: number, state: TaskQueueState): Promise<void> {
  let failure: unknown = null;
  let started = false;
  let allKeys: string[] = [];
  /** 是否已按分段记录过错误，避免任务级再记一条重复项。 */
  let segmentErrorRecorded = false;

  const readyProgress = () => taskProgress(allKeys, taskService.audioKeys(taskId));
  const setRunning = () =>
    taskService.setStatus(taskId, "running", {
      progress: readyProgress(),
      error: null,
      segment_count: allKeys.length,
    });
  const markStopped = () => {
    taskService.setStatus(taskId, "ready", {
      progress: readyProgress(),
      error: null,
      segment_count: allKeys.length,
    });
    logger.warn(`⏹️ 任务 ${taskId} 已停止`);
  };
  const markPaused = () => {
    taskService.setStatus(taskId, "paused", {
      progress: readyProgress(),
      error: null,
      segment_count: allKeys.length,
    });
    logger.warn(`⏸️ 任务 ${taskId} 已暂停`);
  };

  try {
    const task = ensureTask(taskId);
    allKeys = taskService.segmentKeys(taskId);
    const controller = beginRun(taskId);
    started = true;
    setRunning();

    for (;;) {
      if (wasPaused(taskId) || wasStopped(taskId)) break;
      const next = takeNext(state);
      if (!next) break;
      const body = ensureIntermediate(taskId);
      const seg = body.segments[next.key];
      if (!seg) {
        settleJob(next.job, new Error(`段落 ${next.key} 不存在`));
        continue;
      }
      try {
        await synthesizeOne(task, seg, next.key, controller.signal);
      } catch (error) {
        // 停止/暂停导致的取消不计为错误；其余（重试已耗尽）记录错误历史
        if (!wasPaused(taskId) && !wasStopped(taskId) && !isStopError(error)) {
          errorService.record(taskId, "synthesize", `${next.key}: ${getErrorMessage(error)}`);
          segmentErrorRecorded = true;
        }
        throw error;
      }
      setRunning();
      if (!next.job.keys.length) settleJob(next.job);
    }
  } catch (error) {
    failure = error;
  }

  const paused = wasPaused(taskId);
  const stopped = wasStopped(taskId);
  const reason = paused
    ? "已暂停"
    : stopped
      ? "已停止"
      : failure instanceof Error
        ? failure.message
        : failure
          ? String(failure)
          : "任务已结束";
  for (const job of state.jobs) settleJob(job, new Error(reason));

  if (started) {
    if (failure) {
      if (paused) markPaused();
      else if (stopped || isStopError(failure)) markStopped();
      else {
        logger.error(`❌ 任务 ${taskId} 合成失败: ${reason}`);
        if (!segmentErrorRecorded) errorService.record(taskId, "task", reason);
        taskService.setStatus(taskId, "error", { error: reason, segment_count: allKeys.length });
      }
    } else if (paused) {
      markPaused();
    } else if (stopped) {
      markStopped();
    } else {
      const readyAudio = taskService.audioKeys(taskId);
      const done = allAudioReady(allKeys, readyAudio);
      taskService.setStatus(taskId, done ? "done" : "ready", {
        progress: done ? 100 : taskProgress(allKeys, readyAudio),
        segment_count: allKeys.length,
      });
      logger.success(done ? `✅ 任务 ${taskId} 全部段落合成完成` : `✅ 任务 ${taskId} 所选段落合成完成`);
    }
    endRun(taskId);
  }

  state.jobs = [];
  state.cursor = 0;
  state.running = false;
  taskQueues.delete(taskId);
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
