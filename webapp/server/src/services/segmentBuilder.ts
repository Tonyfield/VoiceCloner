import { splitText } from "./segmenter";
import { xmlize } from "./phonetic";
import { enhanceText, type TextEnhanceOptions } from "./textEnhance";
import type { ExtractResult } from "./documentService";

/** One segmented TTS unit, tagged with the chapter/source it came from. */
export interface SegmentEntry {
  text: string;
  phonetic: string;
  source?: string;
}

/**
 * 段落下标 → key。
 *
 * 存成 JSON 对象时，**看起来像整数的 key（如 "100"）会被 JS 引擎按数值排到最前**，
 * 破坏文档顺序（"100" 会排在 "001" 之前）。因此这里按总段数决定宽度，并保证
 * 宽度至少比最大下标多一位，使每个 key 都带前导 0（"0100"），从而始终作为
 * 普通字符串 key 保持插入顺序。
 */
export function padKey(i: number, total: number): string {
  const width = Math.max(3, String(total).length + 1);
  return String(i + 1).padStart(width, "0");
}

/**
 * 数字型 key 按数值比较（"001" < "100"）；只要有一方不是数字型就返回 0，
 * 由稳定排序保持原有插入顺序（自定义 key 如 "part-a" 不受影响）。
 */
export function compareSegmentKeys(a: string, b: string): number {
  const numericA = /^\d+$/.test(a) ? Number(a) : null;
  const numericB = /^\d+$/.test(b) ? Number(b) : null;
  if (numericA !== null && numericB !== null) return numericA - numericB;
  return 0;
}

/** 返回按文档顺序排列的 key（对历史遗留的乱序 intermediate.json 也生效）。 */
export function sortSegmentKeys(keys: string[]): string[] {
  return [...keys].sort(compareSegmentKeys);
}

/**
 * Build segments from an extraction result, tagging each with its source
 * (epub chapter, pdf page, …). Pure CPU work — callers must run it off the
 * request thread (worker) when documents are large.
 */
export function buildSegments(
  extracted: ExtractResult,
  phoneticEnabled: boolean,
  maxChars: number,
  enhance: TextEnhanceOptions = {}
): SegmentEntry[] {
  const segments: SegmentEntry[] = [];
  const push = (texts: string[], source: string) => {
    for (const raw of texts) {
      const text = enhanceText(raw, enhance);
      segments.push({
        text,
        phonetic: phoneticEnabled ? xmlize(text) : "",
        source,
      });
    }
  };
  if (extracted.parts?.length) {
    for (const part of extracted.parts) {
      push(splitText(part.text, maxChars), part.entry);
    }
  } else {
    push(splitText(extracted.text, maxChars), extracted.sourceLabels[0] || "正文");
  }
  return segments;
}

/** Assemble the intermediate.json body from segments (ordered, keyed, padded). */
export function buildIntermediateBody(
  text: string,
  segments: SegmentEntry[]
): { text: string; sources: string[]; segments: Record<string, SegmentEntry> } {
  const sources: string[] = [];
  for (const s of segments) {
    if (s.source && !sources.includes(s.source)) sources.push(s.source);
  }
  const out: Record<string, SegmentEntry> = {};
  segments.forEach((s, i) => {
    out[padKey(i, segments.length)] = s;
  });
  return { text, sources, segments: out };
}
