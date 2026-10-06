import { cleanText } from "./cleanText";

export async function extractPdf(filePath: string): Promise<string> {
  // pdf-parse is a CJS module; import lazily to keep startup light.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require("pdf-parse");
  const data = await pdfParse(filePath);
  return cleanText(data.text || "");
}