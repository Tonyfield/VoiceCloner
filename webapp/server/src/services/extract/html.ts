import { load } from "cheerio";
import type { AnyNode } from "domhandler";
import { cleanText } from "./cleanText";

/** Block-level tags whose boundaries become newlines (port of _html_to_text). */
const BLOCK_TAGS = new Set([
  "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "tr", "section", "article", "header", "footer", "blockquote",
  "ul", "ol", "table", "thead", "tbody", "caption", "option",
]);

/**
 * Convert HTML/XHTML to text preserving paragraph & linebreak structure:
 * block tags append newline boundaries; <br> becomes "\n".
 *
 * Only the document body is extracted: `<head>` and its metadata
 * (`<title>`, `<meta>`, `<link>`, `<style>`, `<script>`, …) are dropped so
 * e.g. the book title never leaks into the first text segment.
 */
export function htmlToText(html: string): string {
  const $ = load(html, null, false);

  // 丢弃 <head> 及其全部元数据标签（<title> 等）。
  $("head, title, meta, link, base, style, script, noscript").remove();

  // 丢弃注释块 <p class="notecontent">…</p>（脚注/校注正文）。
  $("p.notecontent").remove();

  // 丢弃脚注角标锚点：整段可见文本只有 [数字] 的 <a>…</a>（其内容可能是
  // <sup>[1]</sup>）。保留正文中的普通链接。
  $("a").each((_, el) => {
    const visible = $(el).text().replace(/\s+/g, " ").trim();
    if (/^\[\d+\]$/.test(visible)) $(el).remove();
  });

  // 有 <body> 时只取正文；片段（无 body）时退回根节点。
  const $body = $("body").last();
  const container = $body.length ? $body : $.root();
  const out: string[] = [];

  const walk = (el: any): void => {
    el.contents().each((_: number, node: AnyNode) => {
      if (node.type === "text") {
        out.push((node as any).data ?? "");
      } else if (node.type === "tag") {
        const tag = node.tagName.toLowerCase();
        if (tag === "br") {
          out.push("\n");
          return;
        }
        if (BLOCK_TAGS.has(tag)) {
          out.push("\n");
          walk($(node));
          out.push("\n");
        } else {
          walk($(node));
        }
      }
    });
  };

  walk(container);
  return cleanText(out.join(""));
}