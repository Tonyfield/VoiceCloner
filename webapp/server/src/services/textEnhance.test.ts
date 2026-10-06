import assert from "node:assert/strict";
import test from "node:test";
import { TextEnhancer, enhanceText, enhanceOptionsFromParams } from "./textEnhance";
import type { RegexInsertRule } from "./textRules";

test("感叹词前插入中杠（串首/标点边界）", () => {
  assert.equal(enhanceText("啊，原来是你"), "-啊，原来是你");
  assert.equal(enhanceText("哦！"), "-哦！");
  assert.equal(enhanceText("他说：呀，是你"), "他说：-呀，是你");
});

test("语气助词（前面是汉字）不插入", () => {
  assert.equal(enhanceText("好呀"), "好呀");
  assert.equal(enhanceText("你来啊"), "你来啊");
});

test("已插入过不重复；空串原样返回", () => {
  assert.equal(enhanceText("-啊，好"), "-啊，好");
  assert.equal(enhanceText(""), "");
});

test("连续感叹词逐个处理", () => {
  assert.equal(enhanceText("啊，哦，呀"), "-啊，-哦，-呀");
});

test("非感叹词汉字不受影响", () => {
  assert.equal(enhanceText("阿房宫赋"), "阿房宫赋");
});

test("可配置感叹词前缀（含幂等）", () => {
  assert.equal(enhanceText("啊，好", { interjectionPrefix: "~" }), "~啊，好");
  assert.equal(enhanceText("~啊，好", { interjectionPrefix: "~" }), "~啊，好");
  // 关闭前缀（空字符串）时不处理
  assert.equal(enhanceText("啊，好", { interjectionPrefix: "" }), "啊，好");
});

test("在每个分词之间插入填充字符串（含幂等）", () => {
  const out = enhanceText("我们来测试一下", { wordGap: "|" });
  assert.ok(out.includes("|"));
  assert.equal(enhanceText(out, { wordGap: "|" }), out);
});

test("两项同时开启：先分词间隔、再感叹词前缀", () => {
  const out = enhanceText("啊，我们走", { interjectionPrefix: "-", wordGap: "|" });
  assert.ok(out.startsWith("-啊"));
  assert.ok(out.includes("|"));
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

test("enhanceOptionsFromParams 读取复选框与字符", () => {
  // 未设置时，感叹词前缀默认开启并用默认中杠
  assert.deepEqual(enhanceOptionsFromParams({}), {
    interjectionPrefix: "-",
    wordGap: undefined,
    textRules: [],
  });
  assert.deepEqual(enhanceOptionsFromParams({ interjection_prefix_enabled: false }), {
    interjectionPrefix: undefined,
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
      interjectionPrefix: "-",
      wordGap: "/",
      textRules: [{ pattern: "[。]", position: "after", insert: "，\n" }],
    }
  );
});

test("正则插入规则：匹配后插入（after）", () => {
  const rules: RegexInsertRule[] = [{ pattern: "[。]", position: "after", insert: "，" }];
  assert.equal(
    enhanceText("今天天气很好。我们出发吧。", { textRules: rules }),
    "今天天气很好。，我们出发吧。，"
  );
});

test("正则插入规则：匹配前插入（before）", () => {
  const rules: RegexInsertRule[] = [{ pattern: "[。]", position: "before", insert: "\n" }];
  assert.equal(
    enhanceText("今天天气很好。我们出发吧。", { textRules: rules }),
    "今天天气很好\n。我们出发吧\n。"
  );
});

test("正则插入规则：insert 支持 \\n 转义写法（等价于真实换行）", () => {
  const rules: RegexInsertRule[] = [{ pattern: "[。]", position: "after", insert: "\\n" }];
  assert.equal(
    enhanceText("你好。再见。", { textRules: rules }),
    "你好。\n再见。\n"
  );
  assert.equal(enhanceText("你好。\n再见。\n", { textRules: rules }), "你好。\n再见。\n");
});

test("正则插入规则：支持回车换行，且幂等", () => {
  const rules: RegexInsertRule[] = [{ pattern: "[。！？]", position: "after", insert: "\n" }];
  const out = enhanceText("你好。你好吗？", { textRules: rules });
  assert.equal(out, "你好。\n你好吗？\n");
  assert.equal(enhanceText(out, { textRules: rules }), out);
});

test("正则插入规则：多条按顺序实施", () => {
  const rules: RegexInsertRule[] = [
    { pattern: "[。]", position: "after", insert: "，" },
    { pattern: "，", position: "before", insert: "\n" },
  ];
  const out = enhanceText("我们走。他留下。", { textRules: rules });
  assert.equal(out, "我们走。\n，他留下。\n，");
  // 幂等：重复执行结果一致
  assert.equal(enhanceText(out, { textRules: rules }), out);
});

test("正则插入规则：无效正则跳过、空插入跳过", () => {
  const rules: RegexInsertRule[] = [
    { pattern: "[", position: "after", insert: "，" }, // 无效正则
    { pattern: "[。]", position: "after", insert: "" }, // 空插入
    { pattern: "[！]", position: "before", insert: "\n" },
  ];
  assert.equal(enhanceText("你好！", { textRules: rules }), "你好\n！");
});

test("enhanceOptionsFromParams 过滤非法规则项", () => {
  assert.deepEqual(
    enhanceOptionsFromParams({
      text_rules: [
        { pattern: "[。]", position: "after", insert: "，" },
        { pattern: "", position: "after", insert: "，" }, // 空 pattern
        { pattern: "[。]", position: "middle", insert: "，" }, // 非法 position
        { pattern: "[。]", position: "after", insert: 123 }, // 非字符串 insert
        null,
        "oops",
      ],
    }).textRules,
    [{ pattern: "[。]", position: "after", insert: "，" }]
  );
});

test("TextEnhancer 支持链式调用与 toString", () => {
  const out = new TextEnhancer("啊，我们走", { interjectionPrefix: "-", wordGap: "|" })
    .insertWordGaps()
    .prefixInterjections()
    .toString();
  assert.ok(out.startsWith("-啊"));
  assert.ok(out.includes("|"));
});

test("TextEnhancer.applyAll 等价于 enhanceText", () => {
  const options = {
    interjectionPrefix: "-",
    wordGap: "|",
    entities: [{ from: "罗塔里奥", to: "罗塔里奥" }],
  };
  const chained = new TextEnhancer("啊，我们走", options).applyAll().toString();
  assert.equal(chained, enhanceText("啊，我们走", options));
});
