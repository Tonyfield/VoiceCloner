import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { LOG_DIR } from "../config";
import { extractText } from "./documentService";
import { splitText } from "./segmenter";

/**
 * 用真实 EPUB 章节文件验证「抽取 → 分段」逻辑，并逐步打印分段决策：
 *   - 逐行：起新段 / 合并（是否补逗号）/ 合并超上限
 *   - 超上限行：强制切分规则（句末标点 → 空格 → 中文标点 → 硬切分）与切分结果
 *   - 每个最终分段的长度与内容
 *
 * 运行（server 目录）：
 *   npx tsx --test src/services/segmenter.part0016.test.ts
 */
const FILE = path.resolve(__dirname, "../../../../text/tjhd/part0016.html");
const MAX_CHARS = 100;

/** 收集日志行：既打印到控制台，测试结束时也落盘到 LOG_DIR/segmenter/。 */
const logLines: string[] = [];
function log(message: string): void {
  logLines.push(message);
  console.log(message);
}

/** 把本次分段日志写入 <LOG_DIR>/segmenter/part0016_<时间戳>.log，返回文件路径。 */
function saveLogFile(): string {
  const dir = path.join(LOG_DIR, "segmenter");
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    "_",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");
  const file = path.join(dir, `part0016_${stamp}.log`);
  fs.writeFileSync(file, `${logLines.join("\n")}\n`, "utf8");
  return file;
}

test("part0016.html：抽取 + 分段，并输出分段逻辑日志", async (t) => {
  if (!fs.existsSync(FILE)) {
    t.skip(`缺少测试文件: ${FILE}`);
    return;
  }

  const extracted = await extractText(FILE);
  log(`\n==================== 源文件 ====================`);
  log(`文件: ${FILE}`);
  log(
    `抽取: ${extracted.text.length} 字，parts=${extracted.parts?.length ?? 0}，源=${JSON.stringify(extracted.sourceLabels)}`,
  );

  const parts =
    extracted.parts?.length
      ? extracted.parts
      : [{ entry: extracted.sourceLabels[0] || "正文", text: extracted.text }];

  const allSegments: Array<{ source: string; text: string }> = [];

  for (const part of parts) {
    log(`\n==================== part ${part.entry}（${part.text.length} 字）====================`);
    log(`----- 抽取后的文本（每行一条）-----`);
    part.text
      .split("\n")
      .forEach((line, i) => line.trim() && log(`  L${i + 1}: ${line}`));

    log(`----- 分段逻辑（maxChars=${MAX_CHARS}）-----`);
    const segments = splitText(part.text, MAX_CHARS, (msg) => log(`  ${msg}`));

    log(`----- 分段结果（${segments.length} 段）-----`);
    segments.forEach((seg, i) => {
      log(`  #${String(i + 1).padStart(3, "0")} len=${String(seg.length).padStart(3)} | ${seg.replace(/\n/g, "⏎")}`);
    });

    for (const seg of segments) allSegments.push({ source: part.entry, text: seg });
  }

  const lengths = allSegments.map((s) => s.text.length);
  const overLimit = allSegments.filter((s) => s.text.length > MAX_CHARS + 1);
  log(`\n==================== 汇总 ====================`);
  log(
    `共 ${allSegments.length} 段；长度 min=${Math.min(...lengths)} max=${Math.max(...lengths)}；超过 ${MAX_CHARS} 字的段数=${overLimit.length}`,
  );
  if (overLimit.length) {
    log(`注意：以下分段超过 ${MAX_CHARS} 字（该单元内部没有可用的切分点，属预期外的残留）：`);
    overLimit.forEach((s) =>
      log(`  len=${s.text.length} | ${s.text.slice(0, 30)}…${s.text.slice(-12)}`),
    );
  }

  const logFile = saveLogFile();
  log(`\n分段日志已保存: ${logFile}`);
  console.log(`\n分段日志已保存: ${logFile}`);

  // ---- 不变量校验 ----
  assert.ok(allSegments.length > 0, "应产生分段");
  for (const [i, seg] of allSegments.entries()) {
    assert.ok(seg.text.trim().length > 0, `第 ${i + 1} 段不应为空`);
  }

  // 内容完整且顺序一致（忽略空白与合并处补的逗号）
  const normalize = (s: string) => s.replace(/[\s，]/g, "");
  const sourceText = normalize(parts.map((p) => p.text).join("\n"));
  const segmentedText = normalize(allSegments.map((s) => s.text).join(""));
  assert.equal(segmentedText, sourceText, "分段内容应完整覆盖抽取文本且顺序一致");

  // 当前分段逻辑的特征：未超上限的段一定 ≤ maxChars+1（合并处补的「，」不计入上限判定）；
  // 超上限只出现在「单个句子本身超长」时（该句内没有更细的句末切分点）。
  for (const [i, seg] of allSegments.entries()) {
    if (seg.text.length <= MAX_CHARS + 1) continue;
    const sentenceEnds = seg.text.match(/[。！？!?]/g) ?? [];
    assert.ok(
      sentenceEnds.length <= 1,
      `第 ${i + 1} 段超上限但含多个句末标点，说明存在可切分处未切分（len=${seg.text.length}）`,
    );
  }
});
