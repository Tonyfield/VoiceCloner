import { logger } from "../logger";

/**
 * 通用文本替换规则（不依赖 IndexTTS 或其他 TTS 引擎）。
 *
 * 每条规则：把「匹配到 `<pattern>` 的位置」替换为 `<insert>`（action=replace），
 * 或在匹配位置之前/之后插入 `<insert>`（action=before/after，支持回车换行）。
 * `regex` 为 true 时 `pattern` 按 JS 正则解释，否则按字面量匹配。
 * 规则按数组顺序依次实施；无效正则、空 pattern 的规则跳过。
 * insert 支持转义写法：`\n`（回车换行）、`\r`、`\t`、`\\`，也支持直接输入真实换行。
 *
 * 幂等性：同一文本重复执行结果一致（分段与注音两次增强不会叠加）。判定方式：
 *  - before：匹配位置之前已紧邻插入串 → 跳过；
 *  - after：匹配位置之后已紧邻插入串（或仅隔空白）→ 跳过；
 *  - replace：匹配文本已等于替换串 → 跳过（因此替换串不应再包含匹配内容，否则可能重复替换）。
 *
 * 调试：设 `TEXT_RULES_TRACE=0` 关闭逐步日志；用 `TEXT_RULES_TRACE_LIMIT` 调整明细行数上限。
 */

export type TextRuleAction = "replace" | "before" | "after";

export interface TextRule {
  /** 匹配文本：`regex` 为 true 时是 JS 正则，否则是字面量。 */
  pattern: string;
  /** 处理方式：替换匹配文本 / 在匹配前插入 / 在匹配后插入。 */
  action?: TextRuleAction;
  /** 旧字段（兼容历史任务）：等价于 action 为 before/after。 */
  position?: "before" | "after";
  /** 写入的字符串（替换内容或插入内容，支持换行与转义）。 */
  insert: string;
  /** pattern 是否按正则解释；缺省 true（历史规则均为正则）。 */
  regex?: boolean;
}

/** 兼容旧命名。 */
export type RegexInsertRule = TextRule;

// ---------- 逐步调试日志（有预算上限，避免刷爆日志） ----------

const TRACE_ENABLED = process.env.TEXT_RULES_TRACE !== "0";
const RAW_TRACE_LIMIT = Number(process.env.TEXT_RULES_TRACE_LIMIT ?? 2000);
const TRACE_LIMIT = Number.isFinite(RAW_TRACE_LIMIT) ? Math.max(0, RAW_TRACE_LIMIT) : 2000;
let traceBudget = TRACE_LIMIT;

/** 重置逐步日志预算（每次分段/注音开始前调用）。 */
export function resetTextRulesTrace(): void {
  traceBudget = TRACE_LIMIT;
}

/** 把控制字符转成可读转义，便于在日志中辨认。 */
const escapeVisible = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

const showText = (s: string, n = 120): string => {
  const t = s.replace(/\n/g, "⏎");
  return t.length > n ? `${t.slice(0, n)}…(${s.length}字)` : t;
};

const codePoints = (s: string): string =>
  [...s].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ");

function trace(line: string): void {
  if (!TRACE_ENABLED || traceBudget <= 0) return;
  traceBudget -= 1;
  logger.info(`[textRules] ${line}`);
  if (traceBudget === 0) {
    logger.info(
      "[textRules] 逐步明细已达上限，后续只记录规则汇总（可用 TEXT_RULES_TRACE_LIMIT 调整）"
    );
  }
}

/** 解析插入/替换串中的转义：`\n` `\r` `\t` `\\` → 对应字符（也支持直接输入真实换行）。 */
export function decodeInsertEscapes(value: string): string {
  return value.replace(/\\(n|r|t|\\)/g, (_, c) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : "\\"
  );
}

/** 规范化规则的处理方式（兼容旧 position 字段）。 */
export function ruleAction(rule: TextRule): TextRuleAction {
  return rule.action ?? rule.position ?? "after";
}

/** 规范化规则是否按正则解释（缺省视为正则，兼容历史规则）。 */
export function ruleIsRegex(rule: TextRule): boolean {
  return rule.regex !== false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 规则的可读描述（用于 parse 汇总日志）。 */
export function describeRule(rule: TextRule): string {
  const action = ruleAction(rule);
  const mode = ruleIsRegex(rule) ? "" : "(literal)";
  return `/${rule.pattern}/${mode} ${action} "${escapeVisible(rule.insert)}"`;
}

/** after 规则：匹配位置之后是否已算插入过（紧邻，或仅隔空白后紧邻）。 */
function alreadyAfter(matchEnd: number, insert: string, full: string): boolean {
  const after = full.slice(matchEnd);
  if (after.startsWith(insert)) return true;
  // 插入串以空白开头时只做紧邻判定，避免把「空白＋插入串」误判为已插入。
  if (/\s/.test(insert[0])) return false;
  const ws = after.match(/^\s*/)?.[0].length ?? 0;
  return after.slice(ws).startsWith(insert);
}

/** before 规则：匹配位置之前是否已紧邻插入串。 */
function alreadyBefore(matchStart: number, insert: string, full: string): boolean {
  return full.slice(Math.max(0, matchStart - insert.length), matchStart) === insert;
}

/** 对文本按顺序实施替换规则（在匹配前/后插入，或将匹配替换为指定文本；幂等、无效正则跳过）。 */
export function applyTextRules(
  text: string,
  rules: TextRule[],
  context = ""
): string {
  if (!rules.length) return text;
  trace(`输入${context ? `〔${context}〕` : ""} ${text.length}字: ${showText(text)}`);

  let out = text;
  rules.forEach((rule, index) => {
    const label = `规则#${index + 1}`;
    const action = ruleAction(rule);
    // replace 允许空替换串（删除匹配）；before/after 需要有插入内容。
    if (!rule || !rule.pattern || (!rule.insert && action !== "replace")) {
      trace(`${label} 跳过：pattern 为空或 insert 缺失 ${JSON.stringify(rule)}`);
      return;
    }

    let re: RegExp;
    try {
      re = new RegExp(ruleIsRegex(rule) ? rule.pattern : escapeRegExp(rule.pattern), "g");
    } catch (error) {
      trace(`${label} 无效正则 /${rule.pattern}/：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const rawInsert = rule.insert;
    const insert = decodeInsertEscapes(rawInsert);
    let matched = 0;
    let applied = 0;
    let skipped = 0;

    if (action === "replace") {
      out = out.replace(re, (match) => {
        matched += 1;
        if (match === insert) {
          skipped += 1;
          return match;
        }
        applied += 1;
        return insert;
      });
    } else if (action === "before") {
      out = out.replace(re, (match, ...args) => {
        matched += 1;
        const offset = args[args.length - 2] as number;
        const full = args[args.length - 1] as string;
        if (alreadyBefore(offset, insert, full)) {
          skipped += 1;
          return match;
        }
        applied += 1;
        return insert + match;
      });
    } else {
      out = out.replace(re, (match, ...args) => {
        matched += 1;
        const offset = args[args.length - 2] as number;
        const full = args[args.length - 1] as string;
        if (alreadyAfter(offset + match.length, insert, full)) {
          skipped += 1;
          return match;
        }
        applied += 1;
        return match + insert;
      });
    }

    const decodedNote =
      rawInsert === insert
        ? `(码点 ${codePoints(insert)})`
        : `(解析转义为 "${escapeVisible(insert)}" 码点 ${codePoints(insert)})`;
    trace(
      `${label} /${rule.pattern}/ ${action} "${escapeVisible(rawInsert)}"${decodedNote}` +
        `：匹配 ${matched}，应用 ${applied}，幂等跳过 ${skipped}`
    );
    trace(`${label} 结果 ${out.length}字: ${showText(out)}`);
  });

  trace(`输出 ${out.length}字${out === text ? "（无变化）" : ""}`);
  return out;
}
