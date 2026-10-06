import { useEffect, useRef } from "react";

/**
 * 当 `active` 为真时，按 `intervalMs` 周期调用 `callback`，否则停止。
 * 回调经 ref 调用，避免因函数引用变化而反复重建定时器。
 */
export function usePolling(active: boolean, callback: () => void, intervalMs: number): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => callbackRef.current(), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
}
