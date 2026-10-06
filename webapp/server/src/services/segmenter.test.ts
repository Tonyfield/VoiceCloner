import assert from "node:assert/strict";
import test from "node:test";
import { splitText } from "./segmenter";

/** 忽略空白与合并处补的「，」，保留 、；： 以便校验分隔符未丢失。 */
const norm = (s: string) => s.replace(/[\s，]/g, "");

function longSentence(): string {
  return [
    "他先是说明了来意，随后又补充了几点，其中包括时间、地点和人员安排",
    "他还特别强调，任何改动都必须经过评审，否则不予通过，避免出现反复与混乱",
    "这一点非常重要，务必牢记在心，相关的文档也要同步更新，包括设计说明与接口定义",
    "任何人都不得遗漏，直到所有相关人员都完全清楚并且确认无误",
  ].join("；");
}

test("超长单句按中文标点继续切分，每段不超过上限且内容不重复", () => {
  const text = `${longSentence()}。他随后离开了。`;
  const segments = splitText(text, 100);

  assert.ok(segments.length > 1, "超长句应被切分为多段");
  for (const seg of segments) {
    assert.ok(seg.length <= 100, `段长 ${seg.length} 超过上限：${seg.slice(0, 20)}…`);
  }
  assert.equal(norm(segments.join("")), norm(text), "内容应完整且不重复（忽略空白与补的逗号）");
});

test("位于行末的超长单元同样会被切分（而非整体保留）", () => {
  const text = `短句。${longSentence()}。`;
  const segments = splitText(text, 100);

  assert.ok(segments.every((s) => s.length <= 100), "不应存在超过上限的段");
  assert.equal(norm(segments.join("")), norm(text));
});

test("分号/顿号/冒号在切分中不丢失", () => {
  const text = `${"甲、乙；丙：丁，".repeat(12)}结束。`;
  const segments = splitText(text, 100);

  assert.ok(segments.every((s) => s.length <= 100));
  assert.equal(norm(segments.join("")), norm(text), "、；： 等分隔符不应在切分时被丢弃");
  assert.ok(norm(segments.join("")).includes("；"));
  assert.ok(norm(segments.join("")).includes("、"));
  assert.ok(norm(segments.join("")).includes("："));
});

test("maxChars 小于 40 时硬切分也不超过上限", () => {
  const text = `${"甲".repeat(50)}。`;
  const segments = splitText(text, 20);

  assert.ok(segments.length > 1);
  assert.ok(segments.every((s) => s.length <= 20), segments.map((s) => s.length).join(","));
  assert.equal(norm(segments.join("")), norm(text));
});
