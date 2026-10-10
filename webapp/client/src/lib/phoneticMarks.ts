/**
 * 注音内部表达（XML）前端工具。
 * 与后端 phonetic.ts 的 XML 格式保持一致：
 *   <phoneme pinyin="拼音串">原文片段</phoneme> 拼接，只包含被注音文字。
 */

export interface PyMark {
  text: string;
  pinyin: string;
  /**
   * 已标记文字在原文中的起始位置（可选）。
   * 来自 XML 解析或最近一次添加；正文被编辑后位置可能失效，
   * resolveSpans 会校验并以「逐次占用未用出现位置」的方式兜底。
   * 有了它，重复出现的词（如多个「得」）才能各自精确对应到被注音的那一个。
   */
  start?: number;
}

const MARK_TAG_RE = /<phoneme pinyin="([^"]*)">([^<]*)<\/phoneme>/g;

export function parseMarks(xml: string): PyMark[] {
  const marks: PyMark[] = [];
  // 逐段累计「纯文本坐标」：XML = 纯文本 + <phoneme>标记文本</phoneme> 交替拼接，
  // 标记的起始位置 = 其前面所有纯文本与已标记文本的长度之和。
  let pos = 0;
  let cursor = 0;
  for (const m of xml.matchAll(MARK_TAG_RE)) {
    const matchStart = m.index ?? 0;
    pos += xml.slice(cursor, matchStart).length;
    const raw = m[2];
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) marks.push({ text, pinyin: m[1].trim(), start: pos + lead });
    pos += raw.length;
    cursor = matchStart + m[0].length;
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
 *
 * 优先使用标记携带的已知位置（来自 XML 解析或最近一次添加），这样重复出现的文字
 * （同一段里有多个「得」）能精确命中被注音的那一个；位置失效（正文被编辑）时才
 * 回退为「同一段文字出现多次时，按标记顺序依次占用尚未被占用的出现位置」。
 */
function resolveSpans(fullText: string, marks: PyMark[]): Array<Span | null> {
  const spans: Array<Span | null> = marks.map(() => null);
  const claimed: Span[] = [];

  // 1) 先安置带明确位置的标记，避免被其它标记的贪心匹配抢先占用。
  marks.forEach((mark, index) => {
    if (!mark.text || typeof mark.start !== "number" || mark.start < 0) return;
    if (!fullText.startsWith(mark.text, mark.start)) return;
    const span = { start: mark.start, end: mark.start + mark.text.length };
    if (claimed.some((used) => overlaps(used, span))) return;
    claimed.push(span);
    spans[index] = span;
  });

  // 2) 其余标记按原顺序贪心占用第一个尚未被占用的出现位置。
  marks.forEach((mark, index) => {
    if (spans[index] || !mark.text) return;
    let from = 0;
    for (;;) {
      const pos = fullText.indexOf(mark.text, from);
      if (pos < 0) return;
      const span = { start: pos, end: pos + mark.text.length };
      if (!claimed.some((used) => overlaps(used, span))) {
        claimed.push(span);
        spans[index] = span;
        return;
      }
      from = pos + 1;
    }
  });

  return spans;
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
  // 关键：新标记必须带上精确位置，否则 marksToXml/resolveSpans 会把它贪心匹配到
  // 该文字的第一个出现处（重复文字如多个「得」会被注错）。
  return sortByOccurrence(fullText, [...kept, { text, pinyin: pinyin.trim(), start }]);
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

// import { PINYIN_SYLLABLE_SET } from "./pinyinSyllables"; // 暂未使用（见下方注释的校验）

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
    // const base = m[1].toLowerCase();
    // if (!PINYIN_SYLLABLE_SET.has(base)) return { code: "invalidPinyin", token: m[1] };
  }
  return null;
}
