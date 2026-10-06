import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CedictDictionary,
  loadCedict,
} from "./cedict";
import { phoneticXmlToInput, xmlize } from "./phonetic";

const dictionaryPath = path.resolve(
  __dirname,
  "../../../../data/cedict_1_0_ts_utf-8_mdbg.txt",
);

test("CC-CEDICT loads the simplified word and preserves pinyin", () => {
  // 自建 fixture：data 下的词典会随书籍裁剪，不应作为断言依据
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cedict-fixture-"));
  const file = path.join(dir, "cedict.txt");
  fs.writeFileSync(file, "世界銀行 世界银行 [Shi4 jie4 Yin2 hang2] /World Bank/\n", "utf8");
  try {
    const dictionary = loadCedict(file);
    assert.deepEqual(dictionary.matchAt("世界银行", 0), {
      text: "世界银行",
      pinyin: ["Shi4", "jie4", "Yin2", "hang2"],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("longest dictionary match wins", () => {
  const dictionary = new CedictDictionary(
    new Map([
      ["堂", ["Tang2"]],
      ["堂吉诃德", ["Tang2", "ji2", "he1", "de2"]],
    ]),
  );

  assert.deepEqual(dictionary.matchAt("堂吉诃德", 0), {
    text: "堂吉诃德",
    pinyin: ["Tang2", "ji2", "he1", "de2"],
  });
});

test("annotates CEDICT words that align with jieba tokens", () => {
  const dictionary = new CedictDictionary(
    new Map([
      ["银行", ["Yin2", "hang2"]],
      ["行长", ["hang2", "zhang3"]],
    ]),
  );
  const source = "去银行，行长办公室"; // jieba: 去|银行|，|行长|办公室

  assert.equal(
    phoneticXmlToInput(source, xmlize(source, dictionary)),
    "去<银|Yin2><行|hang2>，<行|hang2><长|zhang3>办公室",
  );
});

test("rejects CEDICT words that split a jieba token", () => {
  // CEDICT 里存在「子丑」，但 jieba 把「儿子」「丑八怪」各自作为一个词，
  // 「子丑」从词「儿子」内部起始，必须拒绝。
  const dictionary = new CedictDictionary(
    new Map([["子丑", ["zi3", "chou3"]]]),
  );
  const source = "儿子丑八怪似的";

  assert.equal(xmlize(source, dictionary), source);
});

test("rejects CEDICT words that cut across a jieba token", () => {
  // jieba: 一|身上|好|的。「一身」的结束位置落在分词「身上」内部，
  // 为保证注音标记与「分词文本」严格对齐，不再命中。
  const dictionary = new CedictDictionary(
    new Map([["一身", ["yi1", "shen1"]]]),
  );
  const source = "一身上好的";

  assert.equal(xmlize(source, dictionary), source);
});

test("rejects a single character CEDICT entry inside a jieba token", () => {
  // jieba 把「似的」作为一个词，单字「的」位于其内部，不应命中。
  const dictionary = new CedictDictionary(
    new Map([["的", ["de5"]]]),
  );

  assert.equal(xmlize("似的", dictionary), "似的");
});

test("automatic phonetics recalculate the current segment text", () => {
  const dictionary = new CedictDictionary(
    new Map([["银行", ["Yin2", "hang2"]]]),
  );
  const source = "A银行B";

  assert.equal(
    phoneticXmlToInput(source, xmlize(source, dictionary)),
    "A<银|Yin2><行|hang2>B",
  );
});

test("unmatched text and line breaks pass through unchanged", () => {
  const dictionary = new CedictDictionary(
    new Map([["银行", ["Yin2", "hang2"]]]),
  );
  const source = "原文!\n银行。";

  assert.equal(
    phoneticXmlToInput(source, xmlize(source, dictionary)),
    "原文!\n<银|Yin2><行|hang2>。",
  );
});

test("missing automatic dictionary falls back to plain text", () => {
  const source = "第二章\n堂吉诃德";

  assert.equal(xmlize(source, null), source);
});

assert.ok(fs.existsSync(dictionaryPath));
