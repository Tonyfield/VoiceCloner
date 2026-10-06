import fs from "node:fs";
import { logger } from "../logger";
import { taskService } from "./taskService";
import { userPreferencesService, type UserPreferences } from "./userPreferencesService";

/**
 * 生成音频保留策略（后台低优先级）：
 * - mode=all    ：删除所有 mtime 超过保留期的分段音频；
 * - mode=unused ：仅删除「已超过保留期且不是最新副本」的旧音频（每个分段保留最新一个）。
 * 只清理任务目录内的分段音频（`<key>-<hash>.<ext>`），不动 intermediate.json/uploads/导出产物。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const START_DELAY_MS = 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface SweepResult {
  scanned: number;
  deleted: number;
  bytes: number;
  preferences: UserPreferences;
}

/** 让出事件循环：清理是低优先级任务，不阻塞请求处理。 */
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface AudioTarget {
  path: string;
  size: number;
}

function collectTargets(taskId: number, prefs: UserPreferences, cutoff: number): { scanned: number; targets: AudioTarget[] } {
  const files = taskService.listAudioFilesWithStat(taskId);
  const byKey = new Map<string, typeof files>();
  for (const file of files) {
    const list = byKey.get(file.key) ?? [];
    list.push(file);
    byKey.set(file.key, list);
  }

  const targets: AudioTarget[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (prefs.audioRetentionMode === "all") {
      for (const file of list) {
        if (file.mtimeMs < cutoff) targets.push({ path: file.path, size: file.size });
      }
      continue;
    }
    // unused：保留最新一个；仅删除已到期且非最新的旧副本。
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].mtimeMs < cutoff) targets.push({ path: list[i].path, size: list[i].size });
    }
  }
  return { scanned: files.length, targets };
}

/** 执行一次清理；`reason` 仅用于日志。 */
export async function sweepAudioRetention(reason: string): Promise<SweepResult> {
  const prefs = userPreferencesService.getEffective();
  const cutoff = Date.now() - prefs.audioRetentionDays * DAY_MS;
  const ids = taskService.listIds();

  let scanned = 0;
  let deleted = 0;
  let bytes = 0;

  for (const taskId of ids) {
    const { scanned: count, targets } = collectTargets(taskId, prefs, cutoff);
    scanned += count;
    for (const target of targets) {
      try {
        fs.rmSync(target.path, { force: true });
        deleted += 1;
        bytes += target.size;
      } catch (error) {
        logger.warn(`⚠️ 音频清理失败: ${target.path} (${error instanceof Error ? error.message : String(error)})`);
      }
      await yieldLoop();
    }
    await yieldLoop();
  }

  logger.info(
    `🧹 音频保留清理（${reason}）：扫描 ${scanned}，删除 ${deleted}，释放 ${(bytes / 1024 / 1024).toFixed(1)}MB` +
      `（口径=${prefs.audioRetentionMode}，保留=${prefs.audioRetentionDays}天）`
  );
  return { scanned, deleted, bytes, preferences: prefs };
}

/** 启动后台保留清理：启动后延迟执行一次，之后每 6 小时一次（低优先级）。 */
export function startAudioRetentionScheduler(): void {
  const run = (reason: string) => {
    void sweepAudioRetention(reason).catch((error) =>
      logger.warn(`⚠️ 音频保留清理异常: ${error instanceof Error ? error.message : String(error)}`)
    );
  };
  const startupTimer = setTimeout(() => run("startup"), START_DELAY_MS);
  const intervalTimer = setInterval(() => run("interval"), INTERVAL_MS);
  startupTimer.unref?.();
  intervalTimer.unref?.();
}
