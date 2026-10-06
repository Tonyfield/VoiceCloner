/** unknown → 普通对象（排除 null 与数组）。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 安全解析 JSON 对象文本；失败或结果非对象时返回 fallback。 */
export function parseJsonObject(
  text: string | null | undefined,
  fallback: Record<string, unknown> = {}
): Record<string, unknown> {
  if (!text) return fallback;
  try {
    return asRecord(JSON.parse(text)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** 表单布尔值归一化：true / 'true' → true；键不存在 → undefined。 */
export function parseBooleanFlag(
  input: Record<string, unknown> | undefined,
  key: string
): boolean | undefined {
  if (!input || !(key in input)) return undefined;
  const value = input[key];
  return value === true || value === "true";
}
