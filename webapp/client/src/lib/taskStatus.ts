import type { Task, TaskStatus } from "../api/client";

/** 任务状态 → 展示颜色（列表与详情共用）；文案取自 `st.<status>` 文案。 */
export const STATUS_META: Record<TaskStatus, { color: string }> = {
  idle: { color: "default" },
  segmenting: { color: "processing" },
  ready: { color: "gold" },
  running: { color: "blue" },
  paused: { color: "orange" },
  done: { color: "success" },
  error: { color: "error" },
};

/** 尚未生成分段且不在运行中 → 需要先执行「分段」。 */
export function needsPrepare(task: Task): boolean {
  return task.segment_count === 0 && task.status !== "segmenting" && task.status !== "running";
}

/** 「仅分段」任务在分段完成后不应直接进入语音合成。 */
export function isSkipTtsBlocked(task: Task): boolean {
  return Boolean(task.skip_tts) && !needsPrepare(task);
}
