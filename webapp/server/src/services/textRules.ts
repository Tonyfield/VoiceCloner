import { logger } from "../logger";

/**
 * 通用正则替换规则（不依赖 IndexTTS 或其他 TTS 引擎）。
 *
 * 每条规则：在「匹配到 `<pattern>` 的位置」之前或之后插入 `<insert>`（支持回车换行）。
 * 规则按数组顺序依次实施；无效正则、空 pattern/insert 的规则跳过。
 * insert 支持转义写法：`\n`（回车换行）、`\r`、`\t`、`\\`，也支持直接输入真实换行。
 *
 * 幂等性：同一文本重复执行结果一致。判定方式：
 *  - after：匹配位置之后已紧邻插入串 → 跳过；若中间只有空白（如换行）后紧邻插入串 → 也跳过；
 *  - before：匹配位置之前已紧邻插入串 → 跳过。
 * 这样在「分段」与「注音」两次增强中重复应用不会叠加插入。
 *
 * 调试：设 `TEXT_RULES_TRACE=0` 关闭逐步日志；用 `TEXT_RULES_TRACE_LIMIT` 调整明细行数上限。
 */

export interface RegexInsertRule {
  /** 要匹配的正则表达式（JS 正则字面量字符串，如 `[。！？]`）。 */
  pattern: string;
  /** 在匹配位置之前（before）还是之后（after）插入。 */
  position: "before" | "after";
  /** 要插入的字符串（支持换行，如 `\n` 或真实换行）。 */
  insert: string;
}

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

/** 解析插入串中的转义：`\n` `\r` `\t` `\\` → 对应字符（也支持直接输入真实换行）。 */
export function decodeInsertEscapes(value: string): string {
  return value.replace(/\\(n|r|t|\\)/g, (_, c) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : "\\"
  );
}

/** 规则的可读描述（用于 parse 汇总日志）。 */
export function describeRule(rule: RegexInsertRule): string {
  return `/${rule.pattern}/ ${rule.position} "${escapeVisible(rule.insert)}"`;
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

/** 对文本按顺序实施正则插入规则（幂等、无效正则跳过）。 */
export function applyRegexInsertRules(
  text: string,
  rules: RegexInsertRule[],
  context = ""
): string {
  if (!rules.length) return text;
  trace(`输入${context ? `〔${context}〕` : ""} ${text.length}字: ${showText(text)}`);

  let out = text;
  rules.forEach((rule, index) => {
    const label = `规则#${index + 1}`;
    if (!rule || !rule.pattern || !rule.insert) {
      trace(`${label} 跳过：pattern/insert 为空 ${JSON.stringify(rule)}`);
      return;
    }

    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, "g");
    } catch (error) {
      trace(`${label} 无效正则 /${rule.pattern}/：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const rawInsert = rule.insert;
    const insert = decodeInsertEscapes(rawInsert);
    let matched = 0;
    let applied = 0;
    let skipped = 0;

    if (rule.position === "before") {
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
      `${label} /${rule.pattern}/ ${rule.position} 插入 "${escapeVisible(rawInsert)}"${decodedNote}` +
        `：匹配 ${matched}，插入 ${applied}，幂等跳过 ${skipped}`
    );
    trace(`${label} 结果 ${out.length}字: ${showText(out)}`);
  });

  trace(`输出 ${out.length}字${out === text ? "（无变化）" : ""}`);
  return out;
}
