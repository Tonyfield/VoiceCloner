import path from "node:path";
import { logger } from "../logger";
import { extractTxt } from "./extract/txt";
import { htmlToText } from "./extract/html";
import { extractEpub } from "./extract/epub";
import { extractPdf } from "./extract/pdf";
import { extractDocx } from "./extract/docx";
import { cleanText } from "./extract/cleanText";

export interface ExtractResult {
  text: string;
  sourceLabels: string[];
  format: string;
  /** Per-source text (e.g. epub chapters) — enables chapter-level grouping. */
  parts?: { entry: string; text: string }[];
}

export interface ExtractOptions {
  start?: number;
  end?: number;
}

const SUPPORTED = new Set([
  ".txt", ".md", ".markdown", ".html", ".htm", ".xhtml", ".epub", ".pdf", ".docx",
]);

/** Dispatch extraction by file extension. */
export async function extractText(
  filePath: string,
  opts: ExtractOptions = {}
): Promise<ExtractResult> {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.has(ext)) {
    throw new Error(`不支持的文件格式: ${ext || "(无扩展名)"}`);
  }
  logger.info(`📄 抽取文本: ${path.basename(filePath)} (${ext})`);

  const start = opts.start ?? 1;
  const end = opts.end ?? -1;

  switch (ext) {
    case ".txt":
    case ".md":
    case ".markdown": {
      const text = await extractTxt(filePath);
      return { text, sourceLabels: [path.basename(filePath)], format: ext };
    }
    case ".html":
    case ".htm":
    case ".xhtml": {
      const content = await extractTxtData(filePath);
      const text = cleanText(htmlToText(content));
      return { text, sourceLabels: [path.basename(filePath)], format: ext };
    }
    case ".epub": {
      const parts = extractEpub(filePath, { start, end });
      const text = cleanText(parts.map((p) => p.text).join("\n\n"));
      logger.info(`📚 epub 解析到 ${parts.length} 个 HTML part`);
      return { text, sourceLabels: parts.map((p) => p.entry), format: ext, parts };
    }
    case ".pdf": {
      const text = await extractPdf(filePath);
      return { text, sourceLabels: [path.basename(filePath)], format: ext };
    }
    case ".docx": {
      const text = await extractDocx(filePath);
      return { text, sourceLabels: [path.basename(filePath)], format: ext };
    }
    default:
      throw new Error(`不支持的文件格式: ${ext}`);
  }
}

async function extractTxtData(filePath: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(filePath, "utf8");
}