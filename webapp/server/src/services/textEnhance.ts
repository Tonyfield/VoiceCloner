import { cutWords } from "./jieba";
import { applyRegexInsertRules, describeRule, type RegexInsertRule } from "./textRules";
import { logger } from "../logger";

/**
 * 分段文本增强（通用模块，不绑定任何具体 TTS 引擎）。
 *
 * 以「文本」为处理对象、以「用户参数（TextEnhanceOptions）」为处理配置。
 * 提供可链式调用的 {@link TextEnhancer}：每个处理方法返回对象自身，最后用
 * `toString()` 取出结果，例如：
 *
 * ```ts
 * new TextEnhancer(text, options)
 *   .replaceEntities()        // 专有名词替换（长词优先）
 *   .insertWithRegexRules()   // 正则插入规则（匹配位置前/后插入）
 *   .insertWordGaps()         // jieba 分词间隔
 *   .prefixInterjections()    // 感叹词前缀
 *   .toString();
 * ```
 *
 * 也可用 {@link enhanceText} 一次性按默认顺序执行全部增强。
 *
 * 支持的增强项（可分别开启）：
 *  0. 专有名词替换（entities）：按「专有名词」表的替换文本改写（长词优先）；
 *  1. 正则插入规则（textRules）：按顺序实施正则替换——在匹配到的正则表达式前/后插入指定字符串（支持换行）；
 *  2. 分词间隔（wordGap）：用 jieba 分词后，在每个分词之间插入指定字符串；
 *  3. 感叹词前缀（interjectionPrefix）：在感叹词（啊/哦/呀…）前插入指定字符串。
 *
 * 感叹词判定规则（避免误伤语气助词）：
 *   - 目标字属于 `INTERJECTIONS`；
 *   - 它前面的字符是「边界」——串首、空白或标点，即**不是**汉字/字母/数字/下划线；
 *   - 前面不是已插入的前缀（避免重复插入，保证幂等）。
 *
 * 例：`啊，原来是你` → `-啊，原来是你`；`好呀` → 不变（`呀` 前是汉字）；
 *     `呀，是你` → `-呀，是你`。
 *
 * 说明：增强会写回分段文本（在分段/注音阶段执行一次），因此注音标记与增强后的文本
 * 始终对齐；送 TTS 前不再重复处理。
 */

/** 常见汉语感叹词（叹词）。按需在此增删。 */
export const INTERJECTIONS = "啊哦呀哈嗨嘿哎唉咦哟噢喔喂嗯呃哇哼嘻唷咳";

/** 默认的感叹词前缀（中杠）。 */
export const DEFAULT_INTERJECTION_PREFIX = "-";

export interface EntityReplacement {
  from: string;
  to: string;
}

export interface TextEnhanceOptions {
  /** 在感叹词前插入的字符串；空/未设置表示不处理。 */
  interjectionPrefix?: string;
  /** 在分词之间插入的字符串；空/未设置表示不处理。 */
  wordGap?: string;
  /** 正则插入规则（按顺序实施；在匹配位置前/后插入指定字符串，支持换行）。 */
  textRules?: RegexInsertRule[];
  /** 专有名词替换（长词优先；已替换过的不重复处理）。 */
  entities?: EntityReplacement[];
}

/** 从任务参数解析正则插入规则（仅保留 pattern/position/insert 均合法的项）。 */
function parseTextRules(value: unknown): RegexInsertRule[] {
  if (!Array.isArray(value)) return [];
  const rules: RegexInsertRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      logger.warn(`[textRules] 忽略非法规则项: ${JSON.stringify(item)}`);
      continue;
    }
    const { pattern, position, insert } = item as Record<string, unknown>;
    if (typeof pattern !== "string" || !pattern) {
      logger.warn(`[textRules] 忽略规则（pattern 为空）: ${JSON.stringify(item)}`);
      continue;
    }
    if (position !== "before" && position !== "after") {
      logger.warn(`[textRules] 忽略规则（position 非法）: ${JSON.stringify(item)}`);
      continue;
    }
    if (typeof insert !== "string") {
      logger.warn(`[textRules] 忽略规则（insert 非字符串）: ${JSON.stringify(item)}`);
      continue;
    }
    rules.push({ pattern, position, insert });
  }
  return rules;
}

/** 从任务参数解析增强选项（复选框 + 字符填充框）。 */
export function enhanceOptionsFromParams(
  params: Record<string, unknown>
): TextEnhanceOptions {
  const interjectionEnabled = params.interjection_prefix_enabled !== false;
  const wordGapEnabled = params.word_gap_enabled === true;
  const textRules = parseTextRules(params.text_rules);
  logger.info(
    `[enhance] 解析增强选项: 感叹词前缀=${interjectionEnabled ? JSON.stringify(params.interjection_prefix ?? DEFAULT_INTERJECTION_PREFIX) : "关闭"}` +
      `, 分词间隔=${wordGapEnabled ? JSON.stringify(params.word_gap ?? DEFAULT_INTERJECTION_PREFIX) : "关闭"}` +
      `, 正则规则=${textRules.length} 条`
  );
  if (textRules.length) {
    logger.info(`[enhance] 正则规则: ${textRules.map((r, i) => `#${i + 1} ${describeRule(r)}`).join("; ")}`);
  }
  return {
    interjectionPrefix: interjectionEnabled
      ? String(params.interjection_prefix ?? DEFAULT_INTERJECTION_PREFIX)
      : undefined,
    wordGap: wordGapEnabled ? String(params.word_gap ?? DEFAULT_INTERJECTION_PREFIX) : undefined,
    textRules,
  };
}

export function hasEnhancement(options: TextEnhanceOptions): boolean {
  return (
    Boolean(options.interjectionPrefix) ||
    Boolean(options.wordGap) ||
    Boolean(options.textRules?.length) ||
    Boolean(options.entities?.length)
  );
}

/** 专有名词替换（字面替换，长词优先；替换文本已存在则跳过，保证幂等）。 */
function applyEntityReplacements(text: string, rules: EntityReplacement[]): string {
  let out = text;
  for (const rule of rules) {
    if (!rule.from || !rule.to || rule.from === rule.to) continue;
    if (out.includes(rule.to)) continue;
    out = out.split(rule.from).join(rule.to);
  }
  return out;
}

const HAN_OR_WORD = /[\p{Script=Han}A-Za-z0-9_]/u;

/** 在感叹词前插入前缀（前缀已紧邻则不重复插入）。 */
function applyInterjectionPrefix(text: string, prefix: string): string {
  let out = "";
  let prev = "";
  for (const ch of text) {
    const atBoundary = prev === "" || !HAN_OR_WORD.test(prev);
    if (INTERJECTIONS.includes(ch) && atBoundary && !out.endsWith(prefix)) {
      out += prefix;
    }
    out += ch;
    prev = ch;
  }
  return out;
}

/**
 * 可链式的文本增强器。构造时传入文本与配置，各处理方法返回对象自身，
 * 可任意组合调用，最后用 `toString()`（或 `valueOf()`）取回字符串。
 */
export class TextEnhancer {
  private text: string;
  private readonly options: TextEnhanceOptions;

  constructor(text: string, options: TextEnhanceOptions = {}) {
    this.text = text;
    this.options = options;
  }

  /** 专有名词替换（无配置时为空操作）。 */
  replaceEntities(): this {
    const rules = this.options.entities;
    if (rules?.length) this.text = applyEntityReplacements(this.text, rules);
    return this;
  }

  /** 正则插入规则（无配置时为空操作）。 */
  insertWithRegexRules(): this {
    const rules = this.options.textRules;
    if (rules?.length) {
      this.text = applyRegexInsertRules(this.text, rules, this.text.slice(0, 12));
    }
    return this;
  }

  /** jieba 分词间隔（无配置时为空操作）。 */
  insertWordGaps(): this {
    const gap = this.options.wordGap;
    if (gap) {
      // 过滤掉上一步插入的间隔符，保证重复执行结果一致（幂等）。
      this.text = cutWords(this.text)
        .filter((word) => word !== gap)
        .join(gap);
    }
    return this;
  }

  /** 感叹词前缀（无配置时为空操作）。 */
  prefixInterjections(): this {
    const prefix = this.options.interjectionPrefix;
    if (prefix) this.text = applyInterjectionPrefix(this.text, prefix);
    return this;
  }

  /** 按默认顺序执行全部增强：专有名词 → 正则插入 → 分词间隔 → 感叹词前缀。 */
  applyAll(): this {
    return this.replaceEntities()
      .insertWithRegexRules()
      .insertWordGaps()
      .prefixInterjections();
  }

  toString(): string {
    return this.text;
  }

  valueOf(): string {
    return this.text;
  }
}

/**
 * 对单个分段文本执行增强；顺序：专有名词替换 → 正则插入规则 → 分词间隔 → 感叹词前缀。
 * 无有效选项时原样返回，保证幂等（同一文本重复执行结果一致）。
 */
export function enhanceText(
  text: string,
  options: TextEnhanceOptions = { interjectionPrefix: DEFAULT_INTERJECTION_PREFIX }
): string {
  if (!text || !hasEnhancement(options)) return text;
  return new TextEnhancer(text, options).applyAll().toString();
}
