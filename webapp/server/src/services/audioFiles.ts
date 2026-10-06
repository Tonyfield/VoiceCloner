import crypto from "node:crypto";
import { phoneticXmlToInput } from "./phonetic";

/**
 * 音频文件命名与内容哈希。
 *
 * 文件名格式：`<分段key>-<注音后文本的hash>.<扩展名>`，如 `0001-<40位sha1>.wav`。
 * 这样重新分段后，只要分段文本（已含 IndexTTS 文字增强 + 注音）没变，就能按 hash
 * 复用已生成的语音，不必删除音频文件。
 */

interface SegmentLike {
  text: string;
  phonetic?: string;
}

/** 送 IndexTTS 的最终输入文本（分段文本 → 注音标记 <字|拼音>，无注音时退回原文）。 */
export function segmentTtsInput(seg: SegmentLike): string {
  return phoneticXmlToInput(seg.text, seg.phonetic || "");
}

/** 注音后分段文本的内容哈希（sha1 hex，40 位）。 */
export function segmentContentHash(seg: SegmentLike): string {
  return crypto.createHash("sha1").update(segmentTtsInput(seg), "utf8").digest("hex");
}

/** 音频文件名：`<key>-<hash>.<ext>`。 */
export function buildAudioFileName(key: string, hash: string, ext: string): string {
  return `${key}-${hash}.${ext}`;
}

const AUDIO_NAME_RE = /^(.+)-([0-9a-f]{40})\.([a-z0-9]+)$/i;

export interface ParsedAudioName {
  key: string;
  hash: string;
  ext: string;
}

/** 解析 `<key>-<hash>.<ext>`；不符合约定返回 null（如合并产物、旧文件）。 */
export function parseAudioFileName(name: string): ParsedAudioName | null {
  const m = AUDIO_NAME_RE.exec(name);
  if (!m) return null;
  return { key: m[1], hash: m[2].toLowerCase(), ext: m[3].toLowerCase() };
}
