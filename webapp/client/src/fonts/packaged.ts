/**
 * 没有附带 CSS 的字体包（@fontpkg/*）在这里注入 @font-face。
 * 通过 Vite 的 `?url` 拿到自托管资源地址，避免从 CDN 加载。
 */
import smileySansWoff2 from "@fontpkg/smiley-sans/SmileySans-Oblique.ttf.woff2?url";

let injected = false;

export function injectPackagedFontFaces(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.setAttribute("data-vc-fonts", "packaged");
  style.textContent = [
    "@font-face{",
    'font-family:"Smiley Sans";font-style:oblique;font-weight:400;font-display:swap;',
    `src:url(${smileySansWoff2}) format("woff2");`,
    "}",
  ].join("");
  document.head.appendChild(style);
}
