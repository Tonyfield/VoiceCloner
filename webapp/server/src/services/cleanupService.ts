import fs from "node:fs";
import { taskService } from "./taskService";
import type { JobContext } from "./jobService";

/** 清理口径：unused=删除同分段中非最新的旧副本；all=删除该任务全部分段音频。 */
export type CleanupMode = "unused" | "all";

export interface CleanupResult {
  deleted: number;
  bytes: number;
  total: number;
}

/**
 * 后台清理某任务的分段音频（低优先级，按分段汇报进度）。
 * 手动清理不看保留期：unused 保留每个分段最新一个，all 全删。
 */
export async function cleanupTaskAudio(
  taskId: number,
  mode: CleanupMode,
  ctx: JobContext,
  yieldLoop: () => Promise<void>
): Promise<CleanupResult> {
  const files = taskService.listAudioFilesWithStat(taskId);
  const byKey = new Map<string, typeof files>();
  for (const file of files) {
    const list = byKey.get(file.key) ?? [];
    list.push(file);
    byKey.set(file.key, list);
  }

  const total = byKey.size;
  ctx.report({ processed: 0, total, message: `开始清理（${mode === "all" ? "全部" : "无用"}）` });

  let deleted = 0;
  let bytes = 0;
  let processed = 0;

  for (const list of byKey.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const targets = mode === "all" ? list : list.slice(1);
    for (const file of targets) {
      try {
        fs.rmSync(file.path, { force: true });
        deleted += 1;
        bytes += file.size;
      } catch (error) {
        ctx.log(`删除失败 ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await yieldLoop();
    }
    processed += 1;
    ctx.report({ processed, total, message: `已处理分段 ${processed}/${total}` });
  }

  ctx.log(`清理完成：删除 ${deleted} 个文件，释放 ${(bytes / 1024 / 1024).toFixed(1)}MB`);
  return { deleted, bytes, total };
}
