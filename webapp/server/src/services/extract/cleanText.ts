/**
 * Port of clone-voice-v6 `_clean_text`: fold horizontal whitespace only,
 * preserve newlines, normalize \r\n/\r, drop control chars, strip spaces
 * around newlines and collapse multiple blank lines.
 */
export function cleanText(text: string): string {
  let t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  t = t.replace(/[ \t\v\f]+/g, " ");
  t = t.replace(/ *\n */g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}