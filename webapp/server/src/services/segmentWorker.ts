/**
 * Segmentation worker — runs document extraction + segmentation on a separate
 * thread so the HTTP event loop stays responsive while large documents are
 * processed. Writes the task's intermediate.json itself and reports progress.
 */
import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { TASKS_DIR } from "../config";
import { extractText } from "./documentService";
import { buildIntermediateBody, buildSegments } from "./segmentBuilder";
import type { TextEnhanceOptions } from "./textEnhance";

export interface SegmentWorkerInput {
  taskId: number;
  filePath: string;
  phoneticEnabled: boolean;
  maxChars: number;
  start: number;
  end: number;
  enhance: TextEnhanceOptions;
}

export type SegmentWorkerMessage =
  | { type: "step"; step: string; progress?: number }
  | { type: "done"; segmentCount: number }
  | { type: "error"; message: string };

async function main(): Promise<void> {
  const input = workerData as SegmentWorkerInput;
  const post = (msg: SegmentWorkerMessage) => parentPort?.postMessage(msg);

  try {
    post({ type: "step", step: `读取上传文档: ${path.basename(input.filePath)}`, progress: 5 });
    post({
      type: "step",
      step: `抽取文档文本 (start=${input.start}, end=${input.end})`,
      progress: 10,
    });
    const extracted = await extractText(input.filePath, {
      start: input.start,
      end: input.end,
    });
    post({
      type: "step",
      step: `抽取完成: ${extracted.text.length} 字, ${extracted.sourceLabels.length} 个源`,
      progress: 45,
    });
    for (const label of extracted.sourceLabels) {
      post({ type: "step", step: `源 ${label}` });
    }

    post({
      type: "step",
      step: `分段 (maxChars=${input.maxChars}, phonetic=${input.phoneticEnabled})`,
      progress: 55,
    });
    const segments = buildSegments(extracted, input.phoneticEnabled, input.maxChars, input.enhance);
    post({ type: "step", step: `分段完成: 共 ${segments.length} 段`, progress: 85 });
    for (const [index, seg] of segments.slice(0, 20).entries()) {
      post({
        type: "step",
        step: `${String(index + 1).padStart(3, "0")} [${seg.source}] ${seg.text.slice(0, 40)}`,
      });
    }
    if (segments.length > 20) {
      post({ type: "step", step: `… 其余 ${segments.length - 20} 段省略` });
    }

    const body = buildIntermediateBody(extracted.text, segments);
    const outPath = path.join(TASKS_DIR, String(input.taskId), "intermediate.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const temp = `${outPath}.tmp-worker-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(body, null, 2), "utf8");
    fs.renameSync(temp, outPath);
    post({ type: "step", step: "写出 intermediate.json", progress: 95 });

    post({ type: "done", segmentCount: segments.length });
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

void main();
