import assert from "node:assert/strict";
import test from "node:test";
import { TextEnhancer, enhanceText, enhanceOptionsFromParams } from "./textEnhance";
import type { TextRule } from "./textRules";

test("在每个分词之间插入填充字符串（含幂等）", () => {
  const out = enhanceText("我们来测试一下", { wordGap: "|" });
  assert.ok(out.includes("|"));
  assert.equal(enhanceText(out, { wordGap: "|" }), out);
});

test("专有名词替换：按替换文本改写且幂等", () => {
  const entities = [
    { from: "桑丘·潘沙", to: "“桑丘·潘沙”" },
    { from: "罗塔里奥", to: "罗塔里奥" },
  ];
  const out = enhanceText("桑丘·潘沙对罗塔里奥说", { entities });
  assert.equal(out, "“桑丘·潘沙”对罗塔里奥说");
  // 已替换过的不再重复（幂等）
  assert.equal(enhanceText(out, { entities }), out);
});

test("enhanceOptionsFromParams 读取分词间隔与规则", () => {
  assert.deepEqual(enhanceOptionsFromParams({}), {
    wordGap: undefined,
    textRules: [],
  });
  assert.deepEqual(
    enhanceOptionsFromParams({
      word_gap_enabled: true,
      word_gap: "/",
      text_rules: [{ pattern: "[。]", position: "after", insert: "，\n" }],
    }),
    {
      wordGap: "/",
      textRules: [{ pattern: "[。]", action: "after", insert: "，\n", regex: true }],
    }
  );
});

test("替换规则：替换匹配文本（replace）", () => {
  const rules: TextRule[] = [{ pattern: "，", action: "replace", insert: "。" }];
  assert.equal(enhanceText("你好，世界", { textRules: rules }), "你好。世界");
  // 幂等：替换后不再有匹配
  assert.equal(enhanceText("你好。世界", { textRules: rules }), "你好。世界");
});

test("替换规则：字面量模式（regex=false）", () => {
  const rules: TextRule[] = [{ pattern: "a.b", action: "replace", insert: "X", regex: false }];
  // 字面量只命中 "a.b"，不会命中正则语义下的 "axb"
  assert.equal(enhanceText("a.b axb", { textRules: rules }), "X axb");
});

test("替换规则：匹配后插入（after）", () => {
  const rules: TextRule[] = [{ pattern: "[。]", action: "after", insert: "，" }];
  assert.equal(
    enhanceText("今天天气很好。我们出发吧。", { textRules: rules }),
    "今天天气很好。，我们出发吧。，"
  );
});

test("替换规则：匹配前插入（before）", () => {
  const rules: TextRule[] = [{ pattern: "[。]", action: "before", insert: "\n" }];
  assert.equal(
    enhanceText("今天天气很好。我们出发吧。", { textRules: rules }),
    "今天天气很好\n。我们出发吧\n。"
  );
});

test("替换规则：旧 position 字段仍然生效（向后兼容）", () => {
  const rules: TextRule[] = [{ pattern: "[。]", position: "after", insert: "，" }];
  assert.equal(
    enhanceText("今天天气很好。我们出发吧。", { textRules: rules }),
    "今天天气很好。，我们出发吧。，"
  );
});

test("替换规则：insert 支持 \\n 转义写法（等价于真实换行）", () => {
  const rules: TextRule[] = [{ pattern: "[。]", action: "after", insert: "\\n" }];
  assert.equal(
    enhanceText("你好。再见。", { textRules: rules }),
    "你好。\n再见。\n"
  );
  assert.equal(enhanceText("你好。\n再见。\n", { textRules: rules }), "你好。\n再见。\n");
});

test("替换规则：支持回车换行，且幂等", () => {
  const rules: TextRule[] = [{ pattern: "[。！？]", action: "after", insert: "\n" }];
  const out = enhanceText("你好。你好吗？", { textRules: rules });
  assert.equal(out, "你好。\n你好吗？\n");
  assert.equal(enhanceText(out, { textRules: rules }), out);
});

test("替换规则：多条按顺序实施", () => {
  const rules: TextRule[] = [
    { pattern: "[。]", action: "after", insert: "，" },
    { pattern: "，", action: "before", insert: "\n" },
  ];
  const out = enhanceText("我们走。他留下。", { textRules: rules });
  assert.equal(out, "我们走。\n，他留下。\n，");
  // 幂等：重复执行结果一致
  assert.equal(enhanceText(out, { textRules: rules }), out);
});

test("替换规则：无效正则跳过、空插入跳过", () => {
  const rules: TextRule[] = [
    { pattern: "[", action: "after", insert: "，" }, // 无效正则
    { pattern: "[。]", action: "after", insert: "" }, // 空插入
    { pattern: "[！]", action: "before", insert: "\n" },
  ];
  assert.equal(enhanceText("你好！", { textRules: rules }), "你好\n！");
});

test("enhanceOptionsFromParams 过滤非法规则项", () => {
  assert.deepEqual(
    enhanceOptionsFromParams({
      text_rules: [
        { pattern: "[。]", action: "after", insert: "，" },
        { pattern: "[，]", action: "replace", insert: "。" },
        { pattern: "", action: "after", insert: "，" }, // 空 pattern
        { pattern: "[。]", action: "middle", insert: "，" }, // 非法 action
        { pattern: "[。]", action: "after", insert: 123 }, // 非字符串 insert
        null,
        "oops",
      ],
    }).textRules,
    [
      { pattern: "[。]", action: "after", insert: "，", regex: true },
      { pattern: "[，]", action: "replace", insert: "。", regex: true },
    ]
  );
});

test("TextEnhancer 支持链式调用与 toString", () => {
  const out = new TextEnhancer("我们，走", {
    textRules: [{ pattern: "，", action: "replace", insert: " " }],
    wordGap: "|",
  })
    .applyTextRules()
    .insertWordGaps()
    .toString();
  assert.ok(out.startsWith("我们"));
  assert.ok(out.includes("|"));
  assert.ok(!out.includes("，"));
});

test("TextEnhancer.applyAll 等价于 enhanceText", () => {
  const options = {
    wordGap: "|",
    entities: [{ from: "罗塔里奥", to: "罗塔里奥" }],
  };
  const chained = new TextEnhancer("我们走", options).applyAll().toString();
  assert.equal(chained, enhanceText("我们走", options));
});
