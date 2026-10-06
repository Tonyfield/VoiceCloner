import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { logger } from "../logger";

export type AudioFormat = "wav" | "mp3" | "aac" | "unknown";

/** Detect container format from magic bytes. */
export function detectAudioFormat(buf: Buffer): AudioFormat {
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE"
  ) {
    return "wav";
  }
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3") return "mp3";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    // 0xFFF1/0xFFF9 -> ADTS (aac); 0xFFFB/0xFFF3/0xFFF2 -> MPEG (mp3)
    return (buf[1] & 0x16) === 0x10 ? "aac" : "mp3";
  }
  return "unknown";
}

function hasFfmpeg(): boolean {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

interface ParsedWav {
  channels: number;
  sampleRate: number;
  bits: number;
  data: Buffer;
}

/** Extract PCM data chunk + fmt params from a RIFF/WAVE buffer. */
function parseWav(buf: Buffer): ParsedWav {
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  const dataChunks: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      const len = Math.min(size, buf.length - body);
      dataChunks.push(buf.subarray(body, body + len));
    }
    if (size === 0xffffffff || size === 0) break;
    offset += 8 + size + (size & 1);
  }
  if (!channels || !sampleRate || !bits || !dataChunks.length) {
    throw new Error("WAV 文件格式无效");
  }
  return { channels, sampleRate, bits, data: Buffer.concat(dataChunks) };
}

/** Concatenate same-format WAV files into one PCM WAV (header rebuilt). */
function mergeWavFiles(files: Buffer[]): Buffer {
  const parsed = files.map(parseWav);
  const first = parsed[0];
  for (const p of parsed) {
    if (p.channels !== first.channels || p.sampleRate !== first.sampleRate || p.bits !== first.bits) {
      throw new Error("各段音频采样参数不一致，无法直接拼接，请改用 ffmpeg 合并");
    }
  }
  const data = Buffer.concat(parsed.map((p) => p.data));
  const dataSize = data.length + (data.length & 1); // pad to even chunk size
  const total = 44 + dataSize;
  const out = Buffer.alloc(total);
  out.write("RIFF", 0);
  out.writeUInt32LE(total - 8, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16); // fmt chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(first.channels, 22);
  out.writeUInt32LE(first.sampleRate, 24);
  out.writeUInt32LE(first.sampleRate * first.channels * (first.bits / 8), 28);
  out.writeUInt16LE(first.channels * (first.bits / 8), 32);
  out.writeUInt16LE(first.bits, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataSize, 40);
  data.copy(out, 44);
  return out;
}

/**
 * Merge audio buffers into a single file of the requested format.
 * - Same-format wav/mp3/aac concatenate directly.
 * - Format conversion / mixed sources go through ffmpeg (must be installed).
 */
export async function mergeAudios(
  files: Buffer[],
  format: AudioFormat
): Promise<Buffer> {
  if (!files.length) throw new Error("没有可合并的音频");
  const formats = files.map(detectAudioFormat);
  const uniform = formats.every((f) => f === formats[0]);

  if (uniform && formats[0] === format && format !== "unknown") {
    if (format === "wav") return mergeWavFiles(files);
    // mp3 / aac raw concatenation
    logger.success(`✅ 音频合并完成 (${files.length} 段, ${format} 直拼)`);
    return Buffer.concat(files);
  }

  // conversion / mixed: need ffmpeg
  if (!hasFfmpeg()) {
    throw new Error(`格式转换（→${format}）需要 ffmpeg，请先安装，或直接合并 ${formats[0]} 格式`);
  }
  return mergeWithFfmpeg(files, format);
}

function mergeWithFfmpeg(files: Buffer[], format: AudioFormat): Buffer {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-merge-"));
  try {
    const inputs: string[] = [];
    files.forEach((f, i) => {
      const p = path.join(tmp, `in-${i}.bin`);
      fs.writeFileSync(p, f);
      inputs.push(p);
    });
    const out = path.join(tmp, `out.${format === "aac" ? "aac" : format}`);
    const args = [
      "-y", "-loglevel", "error",
      ...inputs.flatMap((p) => ["-i", p]),
      "-filter_complex", `concat=n=${files.length}:v=0:a=1[a]`,
      "-map", "[a]",
    ];
    if (format === "mp3") args.push("-c:a", "libmp3lame", "-q:a", "2");
    else if (format === "aac") args.push("-c:a", "aac", "-f", "adts");
    else args.push("-c:a", "pcm_s16le", "-f", "wav");
    args.push(out);

    const r = spawnSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0) {
      throw new Error(`ffmpeg 合并失败: ${(r.stderr || "").slice(0, 500)}`);
    }
    const result = fs.readFileSync(out);
    logger.success(`✅ 音频合并完成 (${files.length} 段 → ${format})`);
    return result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
