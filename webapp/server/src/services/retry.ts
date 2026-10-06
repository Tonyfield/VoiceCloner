import { logger } from "../logger";
import { getErrorMessage } from "../shared/errors";

/** 失败重试的退避间隔（毫秒）：10s → 20s → 30s。 */
export const RETRY_DELAYS_MS = [10_000, 20_000, 30_000] as const;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("已取消"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("已取消"));
      },
      { once: true },
    );
  });
}

/**
 * 执行 `fn`，失败后按 10s / 20s / 30s 退避重试（最多重试 3 次，共 4 次尝试）。
 * 停止/暂停（signal.aborted）时不重试，直接抛出。全部失败时抛出最后一次错误。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    signal?: AbortSignal;
    label?: string;
    /** 覆盖退避间隔（测试用）；默认 10s/20s/30s。 */
    delaysMs?: readonly number[];
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  },
): Promise<T> {
  const delays = opts?.delaysMs ?? RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (opts?.signal?.aborted) throw error;
      if (attempt >= delays.length) throw error;
      const waitMs = delays[attempt];
      opts?.onRetry?.(attempt + 1, waitMs, error);
      logger.warn(
        `⏳ ${opts?.label ?? "操作"}失败，${waitMs / 1000}s 后进行第 ${attempt + 1} 次重试：${getErrorMessage(error)}`,
      );
      await delay(waitMs, opts?.signal);
    }
  }
}
