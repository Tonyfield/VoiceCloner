import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict";
import { logger } from "../logger";

/**
 * 中文分词：jieba（精确模式），用于界面「分词文本」展示的通用词边界。
 *
 * 注音（`xmlize`）也以这里的分词边界为对齐约束：CEDICT 词条必须完整覆盖一个或多个
 * jieba 分词，注音标记的跨度因此与界面「分词文本」一致。
 *
 * 结果无损：`cutWords(text).join("") === text`（标点、空白、换行都保留）。
 */

let instance: Jieba | null = null;
let initFailed = false;

function getJieba(): Jieba | null {
  if (instance) return instance;
  if (initFailed) return null;
  try {
    instance = Jieba.withDict(dict);
    return instance;
  } catch (error) {
    initFailed = true;
    logger.warn(
      `无法初始化 jieba 分词，退回按字切分：${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/** jieba 精确模式分词；初始化失败时退化为按字符切分。 */
export function cutWords(text: string): string[] {
  if (!text) return [];
  const jieba = getJieba();
  if (!jieba) return Array.from(text);
  return jieba.cut(text);
}
