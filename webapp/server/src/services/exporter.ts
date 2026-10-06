import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { mergeAudios } from "./audioMerger";
import { taskService } from "./taskService";

/**
 * 音频导出：
 * - scope=chapters + format=mp3|wav ：每章合并为一个音频，整体打成一个 zip；
 * - scope=chapters + format=zip     ：按「章名/分段音频文件」组织，打成一个 zip；
 * - scope=selected + format=mp3|wav ：选中分段合并为单个音频文件；
 * - scope=selected + format=zip     ：选中分段的音频文件打包成一个 zip。
 */

export type ExportScope = "chapters" | "selected";
export type ExportFormat = "mp3" | "wav" | "zip";

export interface ExportResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

const AUDIO_CONTENT_TYPE: Record<"mp3" | "wav", string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

function safeName(value: string, fallback: string): string {
  const cleaned = (value || "").replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned || fallback;
}

/** 章节展示名：text/part0000.html → part0000 */
function chapterLabel(source: string): string {
  const base = source.split("/").pop() || source;
  const noExt = base.replace(/\.(x?html?)$/i, "");
  return safeName(noExt, "正文");
}

/** 收集给定分段的音频；缺失的 key 记入 missing。 */
function collectAudio(taskId: number, keys: string[]): { files: Buffer[]; missing: string[] } {
  const files: Buffer[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const p = taskService.segmentAudioPath(taskId, key);
    if (!p) {
      missing.push(key);
      continue;
    }
    files.push(fs.readFileSync(p));
  }
  return { files, missing };
}

export async function buildExport(
  taskId: number,
  opts: { scope: ExportScope; format: ExportFormat; keys?: string[] }
): Promise<ExportResult> {
  const task = taskService.get(taskId);
  if (!task) throw new Error("任务不存在");
  if (!taskService.readIntermediate(taskId)) throw new Error("中间文件不存在，请先分段");

  const name = safeName(task.name, `task-${taskId}`);

  if (opts.scope === "selected") {
    const keys = opts.keys ?? [];
    if (!keys.length) throw new Error("请先选择要导出的段落");
    const { files, missing } = collectAudio(taskId, keys);
    if (missing.length) {
      throw new Error(`以下段落还没有语音，请先重新合成: ${missing.join(", ")}`);
    }

    if (opts.format === "zip") {
      const zip = new AdmZip();
      for (const key of keys) {
        const p = taskService.segmentAudioPath(taskId, key);
        if (!p) continue;
        zip.addFile(path.basename(p), fs.readFileSync(p));
      }
      return {
        buffer: zip.toBuffer(),
        filename: `${name}-selected-segments.zip`,
        contentType: "application/zip",
      };
    }

    const buffer = await mergeAudios(files, opts.format);
    return {
      buffer,
      filename: `${name}-selected.${opts.format}`,
      contentType: AUDIO_CONTENT_TYPE[opts.format],
    };
  }

  const order = taskService.sourceOrder(taskId);
  const sources = Object.keys(order);
  if (!sources.length) throw new Error("没有可导出的章节");

  const zip = new AdmZip();
  let added = 0;
  for (const source of sources) {
    const keys = order[source];
    const label = chapterLabel(source);

    if (opts.format === "zip") {
      for (const key of keys) {
        const p = taskService.segmentAudioPath(taskId, key);
        if (!p) continue;
        zip.addFile(`${label}/${path.basename(p)}`, fs.readFileSync(p));
        added += 1;
      }
      continue;
    }

    const { files } = collectAudio(taskId, keys);
    if (!files.length) continue;
    const buffer = await mergeAudios(files, opts.format);
    zip.addFile(`${label}.${opts.format}`, buffer);
    added += 1;
  }

  if (!added) throw new Error("没有可导出的音频，请先合成语音");
  const suffix = opts.format === "zip" ? "chapters-segments" : `chapters-${opts.format}`;
  return {
    buffer: zip.toBuffer(),
    filename: `${name}-${suffix}.zip`,
    contentType: "application/zip",
  };
}

/** 导出产物文件名（后台导出任务用）。 */
export function exportFilename(name: string, scope: ExportScope, format: ExportFormat): string {
  const safe = safeName(name, "task");
  if (scope === "selected") {
    return format === "zip" ? `${safe}-selected-segments.zip` : `${safe}-selected.${format}`;
  }
  const suffix = format === "zip" ? "chapters-segments" : `chapters-${format}`;
  return `${safe}-${suffix}.zip`;
}

/**
 * 后台导出：与 buildExport 同口径，但写入目标文件并汇报进度（processed/total）。
 * 低优先级：每个分段处理后调用 yieldLoop 让出事件循环。
 */
export async function exportToFile(
  taskId: number,
  opts: { scope: ExportScope; format: ExportFormat; keys?: string[] },
  destPath: string,
  report: (patch: { processed?: number; total?: number; message?: string }) => void,
  yieldLoop: () => Promise<void>
): Promise<void> {
  const task = taskService.get(taskId);
  if (!task) throw new Error("任务不存在");
  if (!taskService.readIntermediate(taskId)) throw new Error("中间文件不存在，请先分段");

  if (opts.scope === "selected") {
    const keys = opts.keys ?? [];
    if (!keys.length) throw new Error("请先选择要导出的段落");
    const total = keys.length;
    report({ processed: 0, total, message: "准备导出选中分段" });

    if (opts.format === "zip") {
      const zip = new AdmZip();
      let processed = 0;
      for (const key of keys) {
        const p = taskService.segmentAudioPath(taskId, key);
        if (p) zip.addLocalFile(p);
        processed += 1;
        report({ processed, total, message: `已打包分段 ${key}` });
        await yieldLoop();
      }
      fs.writeFileSync(destPath, zip.toBuffer());
      return;
    }

    const { files, missing } = collectAudio(taskId, keys);
    if (missing.length) {
      throw new Error(`以下段落还没有语音，请先重新合成: ${missing.join(", ")}`);
    }
    const buffer = await mergeAudios(files, opts.format);
    report({ processed: total, total, message: "合并选中分段" });
    fs.writeFileSync(destPath, buffer);
    return;
  }

  const order = taskService.sourceOrder(taskId);
  const sources = Object.keys(order);
  if (!sources.length) throw new Error("没有可导出的章节");

  const total = sources.reduce((n, source) => n + (order[source]?.length ?? 0), 0);
  report({ processed: 0, total, message: "准备导出章节" });

  const zip = new AdmZip();
  let processed = 0;
  for (const source of sources) {
    const keys = order[source];
    const label = chapterLabel(source);

    if (opts.format === "zip") {
      for (const key of keys) {
        const p = taskService.segmentAudioPath(taskId, key);
        if (p) zip.addLocalFile(p, label);
        processed += 1;
        report({ processed, total, message: `已打包章节 ${label}` });
        await yieldLoop();
      }
      continue;
    }

    const { files } = collectAudio(taskId, keys);
    if (files.length) {
      const buffer = await mergeAudios(files, opts.format);
      zip.addFile(`${label}.${opts.format}`, buffer);
    }
    processed += keys.length;
    report({ processed, total, message: `已合并章节 ${label}` });
    await yieldLoop();
  }

  fs.writeFileSync(destPath, zip.toBuffer());
}
