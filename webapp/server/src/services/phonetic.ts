import { CEDICT_PATH } from "../config";
import { logger } from "../logger";
import { CedictDictionary, loadCedict, type CedictMatch } from "./cedict";
import { cutWords } from "./jieba";
import { HAN } from "./segmenter";

/**
 * 注音内部表达（XML）与 IndexTTS 注音文本的转换。
 *
 * 内部表达：串接的 <phoneme pinyin="拼音串">原文片段</phoneme> 标记，按词典分词注音，
 * 每个词一个标记，拼音为空格分隔的音节（小写带调号，轻声用 5）。未注音文字原样保留。例：
 *   <phoneme pinyin="e1 pang2 gong1">阿房宫</phoneme>赋
 *
 * IndexTTS 注音格式：<字|拼音>（小写带调号），未注音文字原样。例：
 *   <阿|e1><房|pang2><宫|gong1>赋
 */

export interface PyMark {
  /** 原文片段（text 中的连续文字） */
  text: string;
  /** 拼音串，空格分隔的音节，数量应与 text 中的中文字数一致（允许不一致，多余/缺失按原文输出） */
  pinyin: string;
}

const MARK_TAG_RE = /<phoneme pinyin="([^"]*)">([^<]*)<\/phoneme>/g;

/** 解析内部表达 XML → 有序标记列表。 */
export function parsePhoneticXml(xml: string): PyMark[] {
  const marks: PyMark[] = [];
  for (const m of xml.matchAll(MARK_TAG_RE)) {
    const text = m[2].trim();
    if (!text) continue;
    marks.push({ text, pinyin: m[1].trim() });
  }
  return marks;
}

/**
 * 自动注音（任务 phonetic 开关开启时的初始内部表达）。
 * 效果同 clone-voice-v6.py 的 --phonetic：按词典分词后为每个词生成
 * <phoneme pinyin="...">词</phoneme> 标记；非中文与未分词文字原样保留。
 */
let defaultDictionary: CedictDictionary | null = null;
let dictionaryWarningLogged = false;

function getDefaultDictionary(): CedictDictionary | null {
  if (defaultDictionary) return defaultDictionary;

  try {
    defaultDictionary = loadCedict(CEDICT_PATH);
    return defaultDictionary;
  } catch (error) {
    if (!dictionaryWarningLogged) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`无法加载 CC-CEDICT（${CEDICT_PATH}）：${message}`);
      dictionaryWarningLogged = true;
    }
    return null;
  }
}

/**
 * jieba 分词边界（UTF-16 偏移集合），用于约束 CEDICT 词条对齐到「分词文本」。
 * `cutWords` 是无损分词（join 回原文），因此边界一定覆盖到 `text.length`。
 */
function segmentationBoundaries(text: string): Set<number> {
  const bounds = new Set<number>([0]);
  let pos = 0;
  for (const word of cutWords(text)) {
    pos += word.length;
    bounds.add(pos);
  }
  return bounds;
}

/**
 * 在**整段文本**上做 CEDICT 最长匹配注音，匹配必须与 jieba 的分词结果**严格对齐**：
 * 词条的起始和结束位置都必须是分词边界，即一个命中词条必须**完整覆盖一个或多个
 * jieba 分词**。
 *
 * 这样注音标记的跨度与界面「分词文本」一致，避免标签落在某个分词内部——例如
 * 「其实算不了多大功劳」中 jieba 分词为「算不了」，就不会再去命中内部的「不了」。
 * 代价是当一个 CEDICT 词被 jieba 与其邻居合并成一个分词时（如「去银行行长办公室」
 * 被切成「去|银行行长|办公室」），该词不会单独注音。
 *
 * 其它规则：
 *   - 每个命中要求音节数 == 字数，否则跳过该候选；
 *   - 在允许的起点上按「最长优先」取第一个满足上述条件的词条；
 *   - 无命中时按单字原样输出（不注音）。标点/英文/空白通常不在 CEDICT 中，原样透传。
 */
export function xmlize(
  text: string,
  dictionary?: CedictDictionary | null,
): string {
  if (!text) return "";
  const activeDictionary = dictionary === undefined
    ? getDefaultDictionary()
    : dictionary;
  if (!activeDictionary) return text;

  const bounds = segmentationBoundaries(text);
  let out = "";
  let offset = 0;
  while (offset < text.length) {
    if (bounds.has(offset)) {
      const candidates = activeDictionary.matchesAt(text, offset);
      let chosen: CedictMatch | null = null;
      for (const candidate of candidates) {
        if (Array.from(candidate.text).length !== candidate.pinyin.length) continue;
        const end = offset + candidate.text.length;
        if (bounds.has(end)) {
          chosen = candidate;
          break;
        }
      }
      if (chosen) {
        out += `<phoneme pinyin="${chosen.pinyin.join(" ")}">${chosen.text}</phoneme>`;
        offset += chosen.text.length;
        continue;
      }
    }

    const codePoint = text.codePointAt(offset);
    const character = String.fromCodePoint(codePoint ?? 0);
    out += character;
    offset += character.length;
  }
  return out;
}

/** jieba 分词结果（只取词边界，不含拼音），用于界面「分词文本」展示。 */
export function segmentText(text: string): string[] {
  return cutWords(text);
}

/** 将内部表达 XML 与原文合成为 IndexTTS 注音输入文本。 */
export function phoneticXmlToInput(text: string, xml: string): string {
  if (!xml) return text;
  const marks = parsePhoneticXml(xml);
  let out = "";
  let cursor = 0;
  for (const mk of marks) {
    if (!mk.text) continue;
    const idx = text.indexOf(mk.text, cursor);
    if (idx < 0) continue; // 标记文字已不在原文，跳过该标记
    out += text.slice(cursor, idx);
    out += annotate(mk.text, mk.pinyin);
    cursor = idx + mk.text.length;
  }
  out += text.slice(cursor);
  return out;
}

/** 片段 → <字|拼音>，拼音按中文字逐字消耗；非中文字原样输出。 */
function annotate(segmentText: string, pinyinStr: string): string {
  const syls = pinyinStr.split(/\s+/).filter(Boolean);
  let out = "";
  let s = 0;
  for (const ch of segmentText) {
    if (HAN.test(ch)) {
      const p = syls[s];
      out += p ? `<${ch}|${p}>` : ch;
      s++;
    } else {
      out += ch;
    }
  }
  return out;
}
