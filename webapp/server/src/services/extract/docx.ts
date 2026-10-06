import mammoth from "mammoth";
import { cleanText } from "./cleanText";

export async function extractDocx(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return cleanText(result.value || "");
}