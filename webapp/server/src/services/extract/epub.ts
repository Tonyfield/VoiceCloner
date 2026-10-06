import AdmZip from "adm-zip";
import { htmlToText } from "./html";
import { cleanText } from "./cleanText";

/**
 * Port of EPUB extraction: unzip, collect HTML parts in archive order,
 * optionally apply a part range (1-based, negatives count from end),
 * then concatenate each part's extracted text.
 */

export interface EpubPart {
  entry: string; // zip entry path, e.g. text/part0000.html
  text: string;
}

function sliceRange(
  sources: string[],
  start: number,
  end: number
): string[] {
  const n = sources.length;
  let s = start;
  let e = end;
  if (s < 0) s = n + s + 1;
  if (e < 0) e = n + e + 1;
  s = Math.max(1, Math.min(s, n));
  e = Math.min(n, Math.max(s, e));
  return sources.slice(s - 1, e);
}

export function extractEpub(
  filePath: string,
  opts: { start: number; end: number }
): EpubPart[] {
  const zip = new AdmZip(filePath);
  const entries = zip
    .getEntries()
    .filter((e: any) => /\.(x?html?)$/i.test(e.entryName))
    .map((e: any) => e.entryName)
    .filter((name: string) => !/META-INF|container\.xml/i.test(name))
    .sort((a: string, b: string) => a.localeCompare(b));

  const selected = sliceRange(entries, opts.start, opts.end);

  const parts: EpubPart[] = [];
  for (const entry of selected) {
    const buffer = zip.readFile(entry);
    if (!buffer) continue;
    const html = buffer.toString("utf8");
    parts.push({ entry, text: cleanText(htmlToText(html)) });
  }
  return parts;
}