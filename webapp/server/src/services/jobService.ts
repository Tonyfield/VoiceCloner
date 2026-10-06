import fs from "node:fs";
import path from "node:path";
import { JOBS_DIR } from "../config";
import { logger } from "../logger";

/**
 * 后台任务中心（导出 / 清理）：
 * - 单并发低优先级执行；任务内通过 `setImmediate` 让出事件循环，避免阻塞请求处理。
 * - 进度：percent + processed/total，同时写入任务日志与服务端日志。
 * - 任务与产物为内存 + 临时目录（重启即失；产物下载后/任务过多时清理）。
 */

export type JobType = "export" | "cleanup";
export type JobStatus = "queued" | "running" | "done" | "error";

export interface JobRecord {
  id: string;
  type: JobType;
  taskId: number;
  taskName: string;
  status: JobStatus;
  percent: number;
  processed: number;
  total: number;
  message: string;
  logs: string[];
  resultPath: string | null;
  resultName: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobContext {
  report: (patch: { processed?: number; total?: number; message?: string }) => void;
  log: (line: string) => void;
}

export interface JobResult {
  resultPath?: string;
  resultName?: string;
}

export type JobWorker = (ctx: JobContext) => Promise<JobResult | void>;

const MAX_LOGS = 300;
const MAX_JOBS = 100;

const jobs = new Map<string, JobRecord>();
const order: string[] = [];
const queue: Array<{ id: string; worker: JobWorker }> = [];
let running = false;
let seq = 0;

const nowIso = () => new Date().toISOString();

/** 让出事件循环（低优先级执行）。 */
export const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function jobDir(id: string): string {
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export { jobDir };

function pushLog(job: JobRecord, line: string): void {
  const stamped = `${new Date().toISOString().replace("T", " ").slice(0, 19)} ${line}`;
  job.logs.push(stamped);
  if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
}

function removeResult(job: JobRecord): void {
  if (!job.resultPath) return;
  try {
    fs.rmSync(path.dirname(job.resultPath), { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
  job.resultPath = null;
  job.resultName = null;
}

function evictIfNeeded(): void {
  while (order.length > MAX_JOBS) {
    const id = order.shift();
    if (!id) break;
    const job = jobs.get(id);
    if (job) removeResult(job);
    jobs.delete(id);
  }
}

export const jobService = {
  create(type: JobType, taskId: number, taskName: string): JobRecord {
    const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const job: JobRecord = {
      id,
      type,
      taskId,
      taskName,
      status: "queued",
      percent: 0,
      processed: 0,
      total: 0,
      message: "",
      logs: [],
      resultPath: null,
      resultName: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    jobs.set(id, job);
    order.push(id);
    evictIfNeeded();
    return job;
  },

  get(id: string): JobRecord | undefined {
    return jobs.get(id);
  },

  list(taskId?: number): JobRecord[] {
    const all = order.map((id) => jobs.get(id)).filter((j): j is JobRecord => Boolean(j));
    const filtered = taskId === undefined ? all : all.filter((j) => j.taskId === taskId);
    return filtered.reverse(); // 最新在前
  },

  remove(id: string): boolean {
    const job = jobs.get(id);
    if (!job) return false;
    removeResult(job);
    jobs.delete(id);
    const index = order.indexOf(id);
    if (index >= 0) order.splice(index, 1);
    return true;
  },

  /** 入队并以单并发执行；进度写入任务与服务端日志。 */
  run(id: string, worker: JobWorker): void {
    queue.push({ id, worker });
    pump();
  },
};

function applyReport(job: JobRecord, patch: { processed?: number; total?: number; message?: string }): void {
  if (typeof patch.total === "number") job.total = patch.total;
  if (typeof patch.processed === "number") job.processed = patch.processed;
  if (typeof patch.message === "string") job.message = patch.message;
  job.percent = job.total > 0 ? Math.min(99, Math.floor((job.processed / job.total) * 100)) : 0;
  job.updatedAt = nowIso();
  pushLog(job, `${job.percent}% (${job.processed}/${job.total}) ${job.message}`);
}

async function pump(): Promise<void> {
  if (running) return;
  const item = queue.shift();
  if (!item) return;
  const job = jobs.get(item.id);
  if (!job) {
    void pump();
    return;
  }

  running = true;
  job.status = "running";
  job.updatedAt = nowIso();
  pushLog(job, `任务开始（${job.type}）`);
  logger.info(`🧵 后台任务开始: ${job.id} type=${job.type} task=${job.taskId}`);

  const ctx: JobContext = {
    report: (patch) => applyReport(job, patch),
    log: (line) => {
      pushLog(job, line);
      job.updatedAt = nowIso();
    },
  };

  try {
    const result = await item.worker(ctx);
    job.status = "done";
    job.percent = 100;
    job.updatedAt = nowIso();
    if (result?.resultPath) {
      job.resultPath = result.resultPath;
      job.resultName = result.resultName ?? path.basename(result.resultPath);
    }
    pushLog(job, `任务完成（删除/导出已结束）`);
    logger.success(`✅ 后台任务完成: ${job.id} type=${job.type} task=${job.taskId}`);
  } catch (error) {
    job.status = "error";
    job.error = error instanceof Error ? error.message : String(error);
    job.updatedAt = nowIso();
    pushLog(job, `任务失败: ${job.error}`);
    logger.error(`❌ 后台任务失败: ${job.id} ${job.error}`);
  } finally {
    running = false;
    void pump();
  }
}
