/**
 * Text segmentation — enhanced version of clone-voice-v6 `lib/document_loader.py`
 * `_split_document_text` with additional features:
 * - Skip HTML header content extraction
 * - Enhanced line-based segmentation preserving original structure
 *
 * Rules:
 *  - Text is normalized with `cleanText` first (line breaks preserved).
 *  - Each PHYSICAL LINE is a unit: consecutive lines are MERGED into one
 *    segment while the merged text stays within the limit (`\n` kept between
 *    them), so a dialogue line never glues to its narration above/below.
 *  - At every merge a comma (，) is appended to the end of the previous line
 *    unless it already ends with sentence-ending punctuation (。！？!?.…);
 *    a line ending with a quote also gets the comma.
 *  - Skip HTML header tags (<head>, <title>, <meta>, <style>, <script>) content
 *  - A single line that alone exceeds the limit is force-split: its first
 *    parts become separate segments and its LAST part stays as the pending
 *    segment, so it can still merge with the following lines. Splitting prefers
 *    sentence endings (。！？!? + closing quotes), then space words, then
 *    Chinese commas (，、,；;：:), then raw character chunks of max(40, len/2).
 *  - "Exceeds limit" = len(text) > maxChars OR estimated duration > 30s.
 */
import { cleanText } from "./extract/cleanText";

export const HAN = /\p{Script=Han}/u;

const MAX_EST_SECONDS = 30.0;
/** closing-quote chars appended to sentence delimiters (mirrors python set). */
const CLOSING_QUOTES = "\u201D\u2019\u300D\u300F\"";
/** Sentence-ending punctuation: a merged line already ending with one of these
 *  does not need a separator appended. */
const TERMINAL_PUNCTUATION = "。！？!?.…";
const CHAR_BASE = 0x4e00;
const CHAR_END = 0x9fff;

/** Rejoin adjacent content/delimiter pairs from a capturing split. */
function recombine(parts: string[]): string[] {
  const units: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const unit = parts[i] + parts[i + 1];
    if (unit.trim()) units.push(unit);
  }
  if (parts.length % 2 === 1) {
    const tail = parts[parts.length - 1].trim();
    if (tail) units.push(tail);
  }
  return units;
}

/** Port of `_estimate_duration`: Chinese chars /4, else latin words, else len/12. */
function estimateDuration(text: string): number {
  let chinese = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= CHAR_BASE && cp <= CHAR_END) chinese++;
  }
  const latinWords = (text.match(/[A-Za-z0-9']+/g) || []).length;
  if (chinese && chinese >= Math.max(1, latinWords * 2)) return chinese / 4;
  if (latinWords) return (latinWords / 150) * 60;
  return Math.max(text.length / 12, 1);
}

/** Port of `_would_exceed_limits` (max_tokens_per_segment is unset in v6). */
function wouldExceed(text: string, maxChars: number): boolean {
  return text.length > maxChars || estimateDuration(text) > MAX_EST_SECONDS;
}

/** Port of `_needs_comma`: append a comma when the merged line lacks
 *  sentence-ending punctuation (quotes count as lacking it). */
function needsComma(text: string): boolean {
  const stripped = text.replace(/\s+$/, "");
  return stripped.length > 0 && !TERMINAL_PUNCTUATION.includes(stripped[stripped.length - 1]);
}

/** 句末标点切分（含右引号）；捕获组用于 recombine。 */
const SENTENCE_SPLIT_RE = new RegExp("([。！？!?]+[" + CLOSING_QUOTES + "]*)");
/** 次级标点切分（逗号、顿号、分号、冒号）；捕获组用于 recombine。 */
const SUB_PUNCT_SPLIT_RE = /([，,、；;：:]+)/;

/** 硬切分的块大小，保证不超过上限（maxChars < 40 时取 maxChars）。 */
function hardChunkSize(maxChars: number): number {
  return Math.max(1, Math.min(maxChars, Math.max(40, Math.floor(maxChars / 2))));
}

/**
 * 把文本按规则切成「单元」：指定分隔符（默认句末标点）→ 空格 → 中文标点 → 硬切分。
 * 注意：`sep` 必须带捕获组，否则分隔符会在 split 时丢失。
 */
function chunkableUnits(
  text: string,
  maxChars: number,
  opts?: { sep?: RegExp; label?: string; trace?: (message: string) => void },
): string[] {
  const { sep, label, trace } = opts ?? {};

  const primary = recombine(text.split(sep ?? SENTENCE_SPLIT_RE));
  if (primary.length > 1) {
    trace?.(`    切分单元规则=${label ?? "句末标点(。！？!?)"}，单元数=${primary.length}`);
    return primary;
  }

  if (text.includes(" ")) {
    const words = text.split(" ").filter((s) => s);
    if (words.length > 1) {
      trace?.(`    切分单元规则=空格分词，单元数=${words.length}`);
      return words;
    }
  }

  const sub = recombine(text.split(SUB_PUNCT_SPLIT_RE)).filter((s) => s);
  if (sub.length > 1) {
    trace?.(`    切分单元规则=中文标点(，、；：)，单元数=${sub.length}`);
    return sub;
  }

  const size = hardChunkSize(maxChars);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  trace?.(`    切分单元规则=硬切分(${size} 字/块)，单元数=${chunks.length}`);
  return chunks;
}

/** 单个「单元」仍超上限时继续细分：中文标点 → 硬切分，保证每块 ≤ maxChars。 */
function splitOversizeUnit(
  unit: string,
  maxChars: number,
  trace?: (message: string) => void,
): string[] {
  if (!wouldExceed(unit, maxChars)) return [unit];

  const byPunct = chunkableUnits(unit, maxChars, {
    sep: SUB_PUNCT_SPLIT_RE,
    label: "中文标点(，、；：)",
    trace,
  }).filter(Boolean);
  if (byPunct.length > 1) {
    trace?.(`    单元 len=${unit.length} 超上限 → 按中文标点细分 ${byPunct.length} 块`);
    return byPunct.flatMap((part) => splitOversizeUnit(part, maxChars, trace));
  }

  const size = hardChunkSize(maxChars);
  const hard: string[] = [];
  for (let i = 0; i < unit.length; i += size) hard.push(unit.slice(i, i + size));
  trace?.(`    单元 len=${unit.length} 无更细标点 → 硬切分 ${size} 字/块，共 ${hard.length} 块`);
  return hard;
}

/** 按上限把单元打包成块（单元之间以空格连接）。 */
function packUnits(units: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current} ${unit}`.trim() : unit;
    if (current && wouldExceed(candidate, maxChars)) {
      chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

/** Port of `_force_split`: chunk a single oversize line into units. */
function forceSplit(text: string, maxChars: number, trace?: (message: string) => void): string[] {
  const units = chunkableUnits(text, maxChars, { sep: SENTENCE_SPLIT_RE, trace }).filter(Boolean);
  // 句末标点切完仍超上限的单元（一个很长的句子）→ 继续按中文标点 / 硬切分细分
  const expanded = units.flatMap((unit) => splitOversizeUnit(unit, maxChars, trace));
  const result = packUnits(expanded, maxChars);
  trace?.(`    强制切分结果 ${result.length} 块，长度=[${result.map((c) => c.length).join(", ")}]`);
  return result;
}


/**
 * Enhanced version of `_split_document_text`: split normalized text, merging whole lines.
 *
 * Line-based: processes text line by line while preserving original structure.
 * Adjacent lines may merge while within the limits; at each merge a comma is
 * appended to the previous line unless it already ends with sentence-ending
 * punctuation. When a line alone exceeds the limit it is force-split, and only
 * its last part stays pending so it can still merge with later lines.
 *
 * `onTrace` 可选：逐步输出分段决策（行合并/补逗号/超上限/强制切分），用于测试与排查。
 */
export function splitText(
  text: string,
  maxChars: number,
  onTrace?: (message: string) => void,
): string[] {
  const trace = onTrace ?? (() => {});
  const preview = (s: string) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

  const cleaned = skipHtmlHeader(text);
  const normalized = cleanText(cleaned);
  const sourceLines = normalized.split("\n").filter((l) => l.trim());
  trace(`归一化：输入 ${text.length} 字 → ${normalized.length} 字，有效行数=${sourceLines.length}`);

  const chunks: string[] = [];
  let current = "";
  let lineNo = 0;

  const flush = (reason: string) => {
    if (current) {
      trace(`  ↵ 输出当前段 len=${current.length}（原因：${reason}）`);
      chunks.push(current);
      current = "";
    }
  };

  for (const line of normalized.split("\n")) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed) continue;
    lineNo += 1;

    // A single line that alone exceeds the limit must be force-split. Only its
    // first parts become separate segments; the last part stays pending.
    if (wouldExceed(lineTrimmed, maxChars)) {
      trace(`行#${lineNo} len=${lineTrimmed.length} 超上限(${maxChars}) | ${preview(lineTrimmed)}`);
      flush("该行超上限，改由强制切分处理");
      const parts = forceSplit(lineTrimmed, maxChars, trace);
      if (parts.length === 0) continue;
      chunks.push(...parts.slice(0, -1));
      current = parts[parts.length - 1];
      trace(
        `    前 ${parts.length - 1} 块直接成段；最后一块 len=${current.length} 保留为 pending，可与后续行合并`,
      );
      continue;
    }

    if (!current) {
      trace(`行#${lineNo} len=${lineTrimmed.length} 起新段 | ${preview(lineTrimmed)}`);
      current = lineTrimmed;
      continue;
    }

    const candidate = `${current}\n${lineTrimmed}`;
    if (wouldExceed(candidate, maxChars)) {
      trace(
        `行#${lineNo} len=${lineTrimmed.length} 合并会超上限(${current.length}+1+${lineTrimmed.length}=${candidate.length}>${maxChars}) | ${preview(lineTrimmed)}`,
      );
      flush("合并超上限");
      current = lineTrimmed;
    } else {
      const addComma = needsComma(current);
      if (addComma) current = `${current}，`;
      current = `${current}\n${lineTrimmed}`;
      trace(
        `行#${lineNo} len=${lineTrimmed.length} 合并进当前段${addComma ? "（上一行末尾补 ，）" : "（上一行已是句末标点，不补）"} → len=${current.length} | ${preview(lineTrimmed)}`,
      );
    }
  }

  flush("收尾");
  const result = chunks.filter((c) => c.trim());
  trace(`分段完成：共 ${result.length} 段，长度=[${result.map((c) => c.length).join(", ")}]`);
  return result;
}

/**
 * Skip HTML header content to avoid extracting unwanted metadata
 */
function skipHtmlHeader(html: string): string {
  // Remove DOCTYPE and HTML opening tag
  let cleaned = html.replace(/<!DOCTYPE[^>]*>|<html[^>]*>/gi, '');

  // Find and remove header section
  const headerMatch = cleaned.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (headerMatch) {
    cleaned = cleaned.replace(headerMatch[0], '');
  }

  // Remove any remaining header-related tags that might be outside <head>
  const headerTags = ['<title', '<meta', '<style', '<script'];
  for (const tag of headerTags) {
    const regex = new RegExp(`<${tag}[^>]*>[\s\S]*?<\/${tag.split(' ')[0]}>`, 'gi');
    cleaned = cleaned.replace(regex, '');
  }

  return cleaned;
}
