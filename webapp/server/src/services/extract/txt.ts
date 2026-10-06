import fs from "node:fs/promises";
import { cleanText } from "./cleanText";

/** Plain text & markdown extraction. */
export async function extractTxt(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  return cleanText(content);
}

export async function extractHtml(filePath: string, htmlFn: (html: string) => string): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  return cleanText(htmlFn(content));
}