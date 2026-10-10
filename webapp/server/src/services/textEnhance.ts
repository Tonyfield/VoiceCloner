import { cutWords } from "./jieba";
import { applyTextRules, describeRule, type TextRule } from "./textRules";
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
 *   .applyTextRules()         // 替换规则（替换 / 匹配前/后插入）
 *   .insertWordGaps()         // jieba 分词间隔
 *   .toString();
 * ```
 *
 * 也可用 {@link enhanceText} 一次性按默认顺序执行全部增强。
 *
 * 支持的增强项（可分别开启）：
 *  0. 专有名词替换（entities）：按「专有名词」表的替换文本改写（长词优先）；
 *  1. 替换规则（textRules）：按顺序实施——把匹配文本替换为指定文本、或在匹配前/后插入；
 *     pattern 可作正则（regex=true）或字面量（regex=false）；
 *  2. 分词间隔（wordGap）：用 jieba 分词后，在每个分词之间插入指定字符串。
 *
 * 说明：增强会写回分段文本（在分段/注音阶段执行），因此注音标记与增强后的文本
 * 始终对齐；送 TTS 前不再重复处理。替换规则需保持幂等，避免两次增强叠加。
 */

/** 默认的分词间隔填充串（中杠）。 */
export const DEFAULT_GAP = "-";

export interface EntityReplacement {
  from: string;
  to: string;
}

export interface TextEnhanceOptions {
  /** 在分词之间插入的字符串；空/未设置表示不处理。 */
  wordGap?: string;
  /** 替换规则（按顺序实施：替换匹配文本 / 在匹配前/后插入，支持换行）。 */
  textRules?: TextRule[];
  /** 专有名词替换（长词优先；已替换过的不重复处理）。 */
  entities?: EntityReplacement[];
}

/** 从任务参数解析替换规则（仅保留合法的项）。 */
function parseTextRules(value: unknown): TextRule[] {
  if (!Array.isArray(value)) return [];
  const rules: TextRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      logger.warn(`[textRules] 忽略非法规则项: ${JSON.stringify(item)}`);
      continue;
    }
    const { pattern, action, position, insert, regex } = item as Record<string, unknown>;
    if (typeof pattern !== "string" || !pattern) {
      logger.warn(`[textRules] 忽略规则（pattern 为空）: ${JSON.stringify(item)}`);
      continue;
    }
    // 兼容历史任务的 position 字段（before/after）。
    const act = (action ?? position ?? "after") as unknown;
    if (act !== "replace" && act !== "before" && act !== "after") {
      logger.warn(`[textRules] 忽略规则（action 非法）: ${JSON.stringify(item)}`);
      continue;
    }
    if (typeof insert !== "string") {
      logger.warn(`[textRules] 忽略规则（insert 非字符串）: ${JSON.stringify(item)}`);
      continue;
    }
    if (!insert && act !== "replace") {
      logger.warn(`[textRules] 忽略规则（insert 为空）: ${JSON.stringify(item)}`);
      continue;
    }
    rules.push({
      pattern,
      action: act,
      insert,
      // 缺省按正则解释，兼容历史规则；新规则由前端显式给出布尔值。
      regex: typeof regex === "boolean" ? regex : true,
    });
  }
  return rules;
}

/** 从任务参数解析增强选项（复选框 + 字符填充框）。 */
export function enhanceOptionsFromParams(
  params: Record<string, unknown>
): TextEnhanceOptions {
  const wordGapEnabled = params.word_gap_enabled === true;
  const textRules = parseTextRules(params.text_rules);
  logger.info(
    `[enhance] 解析增强选项: 分词间隔=${wordGapEnabled ? JSON.stringify(params.word_gap ?? DEFAULT_GAP) : "关闭"}` +
      `, 替换规则=${textRules.length} 条`
  );
  if (textRules.length) {
    logger.info(`[enhance] 替换规则: ${textRules.map((r, i) => `#${i + 1} ${describeRule(r)}`).join("; ")}`);
  }
  return {
    wordGap: wordGapEnabled ? String(params.word_gap ?? DEFAULT_GAP) : undefined,
    textRules,
  };
}

export function hasEnhancement(options: TextEnhanceOptions): boolean {
  return (
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

  /** 替换规则（无配置时为空操作）。 */
  applyTextRules(): this {
    const rules = this.options.textRules;
    if (rules?.length) {
      this.text = applyTextRules(this.text, rules, this.text.slice(0, 12));
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

  /** 按默认顺序执行全部增强：专有名词 → 替换规则 → 分词间隔。 */
  applyAll(): this {
    return this.replaceEntities()
      .applyTextRules()
      .insertWordGaps();
  }

  toString(): string {
    return this.text;
  }

  valueOf(): string {
    return this.text;
  }
}

/**
 * 对单个分段文本执行增强；顺序：专有名词替换 → 替换规则 → 分词间隔。
 * 无有效选项时原样返回，保证幂等（同一文本重复执行结果一致）。
 */
export function enhanceText(
  text: string,
  options: TextEnhanceOptions = {}
): string {
  if (!text || !hasEnhancement(options)) return text;
  return new TextEnhancer(text, options).applyAll().toString();
}
