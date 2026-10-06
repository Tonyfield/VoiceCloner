/**
 * 注音内部表达（XML）前端工具。
 * 与后端 phonetic.ts 的 XML 格式保持一致：
 *   <phoneme pinyin="拼音串">原文片段</phoneme> 拼接，只包含被注音文字。
 */

export interface PyMark {
  text: string;
  pinyin: string;
}

const MARK_TAG_RE = /<phoneme pinyin="([^"]*)">([^<]*)<\/phoneme>/g;

export function parseMarks(xml: string): PyMark[] {
  const marks: PyMark[] = [];
  for (const m of xml.matchAll(MARK_TAG_RE)) {
    const text = m[2].trim();
    if (!text) continue;
    marks.push({ text, pinyin: m[1].trim() });
  }
  return marks;
}

export function marksToXml(marks: PyMark[], fullText: string): string {
  const spans = resolveSpans(fullText, marks);
  const entries = marks
    .map((mark, index) => ({ mark, span: spans[index] }))
    .filter((entry): entry is { mark: PyMark; span: Span } => Boolean(entry.span))
    .sort((a, b) => a.span.start - b.span.start);

  let xml = "";
  let cursor = 0;
  for (const { mark, span } of entries) {
    xml += fullText.slice(cursor, span.start);
    xml += `<phoneme pinyin="${mark.pinyin}">${fullText.slice(span.start, span.end)}</phoneme>`;
    cursor = span.end;
  }
  return xml + fullText.slice(cursor);
}

interface Span {
  start: number;
  end: number;
}

/**
 * 解析每个标记在原文中的跨度。
 * 同一段文字出现多次时，按标记顺序依次占用「尚未被占用」的出现位置；
 * 标记顺序与原文顺序不一致（先注后面的词、再注前面的词）也能各自定位，不会被丢弃。
 */
function resolveSpans(fullText: string, marks: PyMark[]): Array<Span | null> {
  const claimed: Span[] = [];
  return marks.map((mark) => {
    if (!mark.text) return null;
    let from = 0;
    for (;;) {
      const index = fullText.indexOf(mark.text, from);
      if (index < 0) return null;
      const span = { start: index, end: index + mark.text.length };
      if (!claimed.some((used) => overlaps(used, span))) {
        claimed.push(span);
        return span;
      }
      from = index + 1;
    }
  });
}

function overlaps(a: Span | null, b: Span): boolean {
  return Boolean(a && a.start < b.end && b.start < a.end);
}

/** 按标记在原文中的实际位置排序（无法定位的保持相对顺序并排在最后）。 */
function sortByOccurrence(fullText: string, marks: PyMark[]): PyMark[] {
  const spans = resolveSpans(fullText, marks);
  return marks
    .map((mark, index) => ({ mark, span: spans[index], index }))
    .sort((a, b) => {
      if (!a.span && !b.span) return a.index - b.index;
      if (!a.span) return 1;
      if (!b.span) return -1;
      return a.span.start - b.span.start;
    })
    .map((entry) => entry.mark);
}

/**
 * 添加标记。
 *
 * - `at` 为选区在原文中的起始位置（来自 textarea 选区，推荐传入），据此精确定位；
 * - **只移除与新标记跨度真正重叠的旧标记**：同一个词在别处出现时各自保留，
 *   因此「黑呢」这类重复出现的词可以分别注音（旧实现按“字集合”去重，会把
 *   同字的其它标记一起删掉）；
 * - 结果按在原文中的先后顺序排序。
 */
export function addMark(
  marks: PyMark[],
  text: string,
  pinyin: string,
  fullText: string,
  at?: number
): PyMark[] {
  if (!text) return marks;
  const spans = resolveSpans(fullText, marks);

  // 定位新标记：优先用选区位置，位置失效时找一个未被占用的匹配
  let start = at !== undefined && fullText.startsWith(text, at) ? at : -1;
  if (start < 0) {
    let cursor = 0;
    for (;;) {
      const index = fullText.indexOf(text, cursor);
      if (index < 0) break;
      if (!spans.some((span) => overlaps(span, { start: index, end: index + text.length }))) {
        start = index;
        break;
      }
      cursor = index + 1;
    }
  }
  if (start < 0) return marks;

  const span: Span = { start, end: start + text.length };
  const kept = marks.filter((_, index) => !overlaps(spans[index], span));
  return sortByOccurrence(fullText, [...kept, { text, pinyin: pinyin.trim() }]);
}

/**
 * 将 text 拆分为可渲染分段：未注音（plain）与已注音（marked）。
 * 标记在原文中找不到时自动跳过（text 被编辑导致失效）。
 */
export type RenderSeg =
  | { marked: false; text: string }
  | { marked: true; text: string; pinyin: string; markIndex: number };

export function renderSegments(fullText: string, marks: PyMark[]): RenderSeg[] {
  const spans = resolveSpans(fullText, marks);
  const entries = marks
    .map((mark, index) => ({ mark, span: spans[index], markIndex: index }))
    .filter((entry): entry is { mark: PyMark; span: Span; markIndex: number } =>
      Boolean(entry.span)
    )
    .sort((a, b) => a.span.start - b.span.start);

  const segs: RenderSeg[] = [];
  let cursor = 0;
  for (const { mark, span, markIndex } of entries) {
    if (span.start > cursor) segs.push({ marked: false, text: fullText.slice(cursor, span.start) });
    segs.push({
      marked: true,
      text: fullText.slice(span.start, span.end),
      pinyin: mark.pinyin,
      markIndex,
    });
    cursor = span.end;
  }
  if (cursor < fullText.length) segs.push({ marked: false, text: fullText.slice(cursor) });
  return segs;
}

// ---------- 拼音输入校验 ----------

import { PINYIN_SYLLABLE_SET } from "./pinyinSyllables";

/** 单个音节：字母 + 可选声调数字（1~5）。声调可省略，如 zhi / er / zi 也允许。 */
const SYLLABLE_RE = /^([a-zA-Z]+)([1-5])?$/;

/** 校验失败时的错误码与词元，由调用方按当前语种映射文案。 */
export type PinyinError = {
  code: "invalidSyllable" | "invalidPinyin";
  token: string;
};

/**
 * 校验注音字符串。多个音节以空格分隔，如 "tang2 ji2 he1 de2"。
 * 声调数字可省略（如 "zhi er zi" 同样合法）。返回错误码；通过则返回 null。
 */
export function validatePinyin(input: string): PinyinError | null {
  const trimmed = input.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const m = SYLLABLE_RE.exec(tok);
    if (!m) return { code: "invalidSyllable", token: tok };
    const base = m[1].toLowerCase();
    if (!PINYIN_SYLLABLE_SET.has(base)) return { code: "invalidPinyin", token: m[1] };
  }
  return null;
}
