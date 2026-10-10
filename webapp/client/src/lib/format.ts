/**
 * 进度百分比显示：取 0–100 的整数。
 * 未真正到达 100% 时即使四舍五入到 100（如 99.5%）也显示为其下取整，
 * 避免进度条文字提前显示 100%；只有真正 ≥100 才显示 100%。
 */
export function displayPercent(percent?: number): number {
  const p = typeof percent === "number" && Number.isFinite(percent) ? percent : 0;
  if (p >= 100) return 100;
  return Math.floor(Math.max(0, p));
}
