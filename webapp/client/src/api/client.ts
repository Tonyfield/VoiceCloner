import axios from "axios";
import { clearSession, readToken } from "../lib/session";

const api = axios.create({ baseURL: "/api" });

api.interceptors.request.use((cfg) => {
  const token = readToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      clearSession();
      window.location.href = "/";
    }
    return Promise.reject(err);
  }
);

// ---------- types ----------
export interface ParamField {
  title?: string;
  type: string;
  default?: unknown;
  required?: boolean;
  options?: unknown[];
  /** 依赖字段名：其值为 truthy 时才显示本字段 */
  show_when?: string;
  /** 字段说明，展示在输入框下方 */
  help?: string;
  /** number/integer：最小值 */
  min?: number;
  /** number/integer：最大值 */
  max?: number;
  /** number/integer：步长 */
  step?: number;
  /** 输入框提示文字 */
  placeholder?: string;
  /** text 类型：TextArea 的行数 */
  rows?: number;
  /** 栅格宽度（24 = 整行）；用于让多个参数并排 */
  span?: number;
  /** 条件不成立时字段灰化但仍显示（语法同 show_when） */
  enabled_when?: string;
}

export interface ModelSpec {
  id: number;
  name: string;
  api_url: string;
  api_path: string;
  api_key: string;
  parameters_schema_yaml: string;
  schema?: { label: string; params: Record<string, ParamField> };
}

export interface Voice {
  id: number;
  name: string;
  file_name: string;
  size: number;
  created_at: string;
}

export type TaskStatus = "idle" | "segmenting" | "ready" | "running" | "paused" | "done" | "error";

export interface TaskStatusResponse {
  id: number;
  name: string;
  status: TaskStatus;
  progress: number;
  segment_count: number;
  error: string | null;
  files: string[];
  skip_tts: boolean;
  error_count: number;
}

export interface Task {
  id: number;
  name: string;
  model_id: number | null;
  params_json: string;
  status: TaskStatus;
  progress: number;
  segment_count: number;
  skip_tts: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
  files: string[];
  /** 已上传文档的原始文件名（无文档时为 null） */
  upload_name?: string | null;
}

// ---------- auth ----------
export async function login(username: string, password: string) {
  const { data } = await api.post("/auth/login", { username, password });
  return data as { token: string; user: { id: number; username: string } };
}
export async function changePassword(oldPassword: string, newPassword: string) {
  const { data } = await api.post("/auth/change-password", { oldPassword, newPassword });
  return data;
}

export type AudioRetentionMode = "all" | "unused";
export interface UserPreferences {
  /** 生成音频在后台保留的天数（7/14/21/30/90/180/270/365）。 */
  audioRetentionDays: number;
  /** 到期删除口径。 */
  audioRetentionMode: AudioRetentionMode;
}

export async function getPreferences() {
  const { data } = await api.get("/auth/preferences");
  return data as UserPreferences;
}

export async function updatePreferences(patch: Partial<UserPreferences>) {
  const { data } = await api.put("/auth/preferences", patch);
  return data as UserPreferences;
}

// ---------- models ----------
export async function getModels() {
  const { data } = await api.get("/models");
  return data as ModelSpec[];
}
export async function saveModel(payload: Partial<ModelSpec>, id?: number) {
  if (id) return (await api.put(`/models/${id}`, payload)).data;
  return (await api.post("/models", payload)).data as { id: number };
}
export async function deleteModel(id: number) {
  return (await api.delete(`/models/${id}`)).data;
}

// ---------- voices ----------
export async function getVoices() {
  const { data } = await api.get("/voices");
  return data as Voice[];
}
export async function uploadVoice(name: string, file: File) {
  const fd = new FormData();
  fd.append("file", file);
  if (name) fd.append("name", name);
  return (await api.post("/voices", fd)).data as Voice;
}
export async function deleteVoice(id: number) {
  return (await api.delete(`/voices/${id}`)).data;
}

// ---------- tasks ----------
export async function getTasks() {
  const { data } = await api.get("/tasks");
  return data as Task[];
}

/** 单个任务详情（工作区全屏页按 :id 加载）。 */
export async function getTask(id: number) {
  const { data } = await api.get(`/tasks/${id}`);
  return data as Task;
}
export interface TaskPayload {
  name: string;
  model_id?: number | null;
  params: Record<string, unknown>;
  skip_tts: boolean;
  file?: File;
  overwrite?: boolean;
}
export async function createTask(p: TaskPayload) {
  const fd = new FormData();
  fd.append("name", p.name);
  if (p.model_id) fd.append("model_id", String(p.model_id));
  fd.append("params_json", JSON.stringify(p.params));
  fd.append("skip_tts", p.skip_tts ? "true" : "false");
  if (p.overwrite) fd.append("overwrite", "true");
  if (p.file) fd.append("file", p.file);
  return (await api.post("/tasks", fd)).data as { id: number; name: string; status: "segmenting" };
}
export async function updateTask(id: number, p: Partial<TaskPayload>) {
  const fd = new FormData();
  if (p.name) fd.append("name", p.name);
  if (p.model_id !== undefined && p.model_id !== null) fd.append("model_id", String(p.model_id));
  if (p.params) fd.append("params_json", JSON.stringify(p.params));
  if (p.skip_tts !== undefined) fd.append("skip_tts", p.skip_tts ? "true" : "false");
  if (p.file) fd.append("file", p.file);
  return (await api.put(`/tasks/${id}`, fd)).data;
}
export async function deleteTask(id: number) {
  return (await api.delete(`/tasks/${id}`)).data;
}
export async function runTask(id: number) {
  return (await api.post(`/tasks/${id}/run`)).data;
}
export async function prepareTask(id: number) {
  return (await api.post(`/tasks/${id}/prepare`)).data as {
    ok: boolean;
    message: string;
    steps?: string[];
  };
}
export async function ttsTask(id: number, keys?: string[], skipExisting?: boolean) {
  const body = keys || skipExisting ? { keys, skipExisting } : undefined;
  return (await api.post(`/tasks/${id}/tts`, body)).data as { ok: boolean; message: string };
}
export async function stopTask(id: number) {
  return (await api.post(`/tasks/${id}/stop`)).data as { ok: boolean; message: string };
}
export async function pauseTask(id: number) {
  return (await api.post(`/tasks/${id}/pause`)).data as { ok: boolean; message: string };
}
export async function resumeTask(id: number) {
  return (await api.post(`/tasks/${id}/resume`)).data as { ok: boolean; message: string };
}
export interface PhoneticBatchResult {
  ok: boolean;
  updated: number;
  keys: string[];
}
export async function phoneticTask(id: number, keys?: string[]) {
  const body = keys === undefined ? undefined : { keys };
  return (await api.post(`/tasks/${id}/phonetic`, body)).data as PhoneticBatchResult;
}
export async function getTaskStatus(id: number) {
  const { data } = await api.get(`/tasks/${id}/status`);
  return data as TaskStatusResponse;
}
/** 服务端权威的「分段 key → 当前内容匹配的音频文件名」。 */
export async function getTaskAudioMap(id: number) {
  const { data } = await api.get(`/tasks/${id}/audio-map`);
  return (data as { audio: Record<string, string> }).audio;
}

export interface TaskErrorRow {
  id: number;
  task_id: number;
  stage: string;
  message: string;
  created_at: string;
}

/** 任务错误历史（重试耗尽后记录）。 */
export async function getTaskErrors(id: number) {
  const { data } = await api.get(`/tasks/${id}/errors`);
  return (data as { errors: TaskErrorRow[] }).errors;
}

export async function clearTaskErrors(id: number) {
  return (await api.delete(`/tasks/${id}/errors`)).data as { ok: boolean; cleared: number };
}
export function taskFileUrl(id: number, name: string) {
  return `/api/tasks/${id}/files/${encodeURIComponent(name)}`;
}

// ---------- segments (task working interface) ----------
export interface Segment {
  key: string;
  text: string;
  phonetic: string;
  source: string;
  audio: string | null;
}
export interface TaskInfo {
  status: TaskStatus;
  progress: number;
  error: string | null;
  text: string;
  sources: string[];
  segmentCount: number;
  /** 当前任务设置的分段长度（字/段）。 */
  maxChars: number;
}
export interface AutoPhoneticResult {
  text: string;
  phonetic: string;
}
export interface SegmentsPage {
  total: number;
  offset: number;
  limit: number;
  items: Segment[];
}
/** Lightweight: chapter labels + counts only (fast for huge tasks). */
export async function getTaskInfo(id: number) {
  const { data } = await api.get(`/tasks/${id}/info`);
  return data as TaskInfo;
}
/** Page of segments within one chapter. Omit `limit` to fetch the whole chapter. */
export async function getSegmentsPage(id: number, source: string, offset = 0, limit?: number) {
  const { data } = await api.get(`/tasks/${id}/segments`, {
    params: { source, offset, ...(limit !== undefined ? { limit } : {}) },
  });
  return data as SegmentsPage;
}
export async function updateSegment(
  id: number,
  key: string,
  patch: { text?: string; phonetic?: string }
) {
  return (await api.put(`/tasks/${id}/segments/${key}`, patch)).data;
}
export interface SegmentSearchHit {
  key: string;
  source: string;
}
/** 在整篇中间结果中按原文搜索分段（支持大小写敏感 / 正则 / 按标记类型筛选）。 */
export async function searchSegments(
  id: number,
  opts: { query: string; caseSensitive: boolean; wildcard: boolean; mark?: SegmentMark | null }
) {
  const { data } = await api.post(`/tasks/${id}/search`, opts);
  return data as { total: number; results: SegmentSearchHit[] };
}

export type SegmentMark = "like" | "dislike";

export interface MarkInfo {
  mark: SegmentMark;
  feedback: string;
  updated_at: string;
}

/** 任务下全部标记：key → { mark, feedback }。 */
export async function getTaskMarks(id: number) {
  const { data } = await api.get(`/tasks/${id}/marks`);
  return (data as { marks: Record<string, MarkInfo> }).marks;
}

/** 设置/取消分段标记（点踩可附反馈，反馈可为空）。 */
export async function setSegmentMark(
  id: number,
  key: string,
  mark: SegmentMark | null,
  feedback = ""
) {
  const { data } = await api.put(`/tasks/${id}/segments/${key}/mark`, { mark, feedback });
  return data as { ok: boolean; marks: Record<string, MarkInfo> };
}

export interface SegmentStep {
  id: number;
  task_id: number;
  segment_key: string;
  step: "segment" | "phonetic" | "synthesize";
  detail: Record<string, unknown>;
  status: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

/** 某个分段的关键步骤记录（分段/注音/合成）。 */
export async function getSegmentSteps(id: number, key: string) {
  const { data } = await api.get(`/tasks/${id}/segments/${key}/steps`);
  return (data as { steps: SegmentStep[] }).steps;
}
export async function autoPhonetic(id: number, key: string, text: string) {
  const { data } = await api.post(`/tasks/${id}/segments/${key}/auto-phonetic`, { text });
  return data as AutoPhoneticResult;
}
export interface SegmentWordsResult {
  text: string;
  words: string[];
}
/** jieba 分词结果（仅词边界，不含拼音）。 */
export async function segmentText(id: number, key: string, text: string) {
  const { data } = await api.post(`/tasks/${id}/segments/${key}/segment`, { text });
  return data as SegmentWordsResult;
}
export async function synthesizeSegment(id: number, key: string) {
  return (await api.post(`/tasks/${id}/segments/${key}/synthesize`)).data;
}
export type ExportScope = "chapters" | "selected";
export type ExportFormat = "mp3" | "wav" | "zip";
/** 导出音频：每章 / 选中分段，mp3|wav（合并）或 zip（打包分段音频）。 */
export async function exportAudio(
  id: number,
  opts: { scope: ExportScope; format: ExportFormat; keys?: string[] }
): Promise<{ blob: Blob; filename: string }> {
  try {
    const res = await api.post(`/tasks/${id}/export`, opts, { responseType: "blob" });
    const disposition = String(res.headers["content-disposition"] || "");
    const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const filename = match
      ? decodeURIComponent(match[1])
      : `export.${opts.format === "zip" ? "zip" : opts.format}`;
    return { blob: res.data as Blob, filename };
  } catch (error: any) {
    // responseType=blob 时错误体也是 Blob，需读出来还原 { error }
    const data = error?.response?.data;
    if (data instanceof Blob) {
      const text = await data.text();
      let msg = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error) msg = parsed.error;
      } catch {
        /* 非 JSON，保留原文 */
      }
      throw new Error(msg);
    }
    throw error;
  }
}

// ---------- 后台任务（导出 / 清理）----------

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
  resultName: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listJobs(taskId?: number) {
  const { data } = await api.get("/jobs", {
    params: taskId === undefined ? undefined : { taskId },
  });
  return (data as { jobs: JobRecord[] }).jobs;
}

export async function getJob(id: string) {
  return (await api.get(`/jobs/${id}`)).data as JobRecord;
}

export async function deleteJob(id: string) {
  await api.delete(`/jobs/${id}`);
}

/** 创建后台导出任务（进度见「文件传输」页）。 */
export async function createExportJob(
  id: number,
  opts: { scope: ExportScope; format: ExportFormat; keys?: string[] }
) {
  return (await api.post(`/tasks/${id}/export-jobs`, opts)).data as { jobId: string };
}

/** 创建后台清理任务：unused=非最新副本；all=全部分段音频。 */
export async function createCleanupJob(id: number, mode: "unused" | "all") {
  return (await api.post(`/tasks/${id}/cleanup-jobs`, { mode })).data as { jobId: string };
}

/** 下载导出产物（经 axios 带鉴权，再触发浏览器保存）。 */
export async function downloadJobResult(jobId: string, filename: string) {
  const res = await api.get(`/jobs/${jobId}/download`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- 搜索历史（每个任务最多最近 100 条） ----------

export interface SearchHistoryItem {
  id: number;
  query: string;
  caseSensitive: boolean;
  wildcard: boolean;
  mark: string;
  createdAt: string;
}

export interface SearchHistoryPayload {
  query: string;
  caseSensitive?: boolean;
  wildcard?: boolean;
  mark?: string;
}

export async function getSearchHistory(taskId: number) {
  const { data } = await api.get(`/tasks/${taskId}/search-history`);
  return data as { items: SearchHistoryItem[]; max: number };
}

export async function addSearchHistory(taskId: number, payload: SearchHistoryPayload) {
  const { data } = await api.post(`/tasks/${taskId}/search-history`, payload);
  return data as { items: SearchHistoryItem[]; max: number };
}

export async function deleteSearchHistoryItem(taskId: number, historyId: number) {
  const { data } = await api.delete(`/tasks/${taskId}/search-history/${historyId}`);
  return data as { items: SearchHistoryItem[]; max: number };
}

// ---------- 专有名词标注（named_entities） ----------

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

export type NamedEntityGlobalKind = "wrap" | "connector";

export async function getNamedEntities(): Promise<{ items: NamedEntity[]; types: string[] }> {
  const { data } = await api.get("/named-entities");
  return data as { items: NamedEntity[]; types: string[] };
}

export async function createNamedEntity(patch: NamedEntityPatch): Promise<NamedEntity> {
  const { data } = await api.post("/named-entities", patch);
  return (data as { item: NamedEntity }).item;
}

export async function updateNamedEntity(id: number, patch: NamedEntityPatch): Promise<NamedEntity> {
  const { data } = await api.put(`/named-entities/${id}`, patch);
  return (data as { item: NamedEntity }).item;
}

export async function deleteNamedEntity(id: number): Promise<void> {
  await api.delete(`/named-entities/${id}`);
}

export async function applyNamedEntityGlobal(
  kind: NamedEntityGlobalKind,
  value: string
): Promise<{ updated: number; items: NamedEntity[] }> {
  const { data } = await api.post("/named-entities/apply-global", { kind, value });
  return data as { updated: number; items: NamedEntity[] };
}
