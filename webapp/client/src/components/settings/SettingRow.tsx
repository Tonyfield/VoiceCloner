import type { ReactNode } from "react";

/**
 * 一行设置：标签右对齐、控件左对齐。
 * 用 Fragment 返回，使标签与控件成为父级 `.st-grid` 的直接 grid item，
 * 从而整块面板共享同一标签列宽、控件左边缘对齐。
 */
export function SettingRow({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <div className="st-label" title={label}>
        {label}
        {required && <span style={{ color: "var(--vc-error, #ff4d4f)", marginLeft: 2 }}>*</span>}
      </div>
      <div className="st-control">{children}</div>
    </>
  );
}

/** 估算一段文本的像素宽度（CJK 13px / 拉丁 7.5px），用于让 Select 宽度贴合内容。 */
function textWidthPx(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 13 : 7.5;
  }
  return width;
}

/** 该字段最长选项的文本（用于 data 属性与宽度校验）。 */
export function longestOption(options: unknown[]): string {
  return options.reduce<string>(
    (longest, option) => (String(option ?? "").length > longest.length ? String(option ?? "") : longest),
    ""
  );
}

/**
 * Select 宽度：由最长选项文本决定，min 132px、max 360px。
 * 最短选项 → 取下限 132；最长选项 → 触顶 360 后用省略号 + tooltip。
 */
export function selectWidth(options: unknown[]): number {
  return Math.min(360, Math.max(132, Math.round(textWidthPx(longestOption(options)) + 48)));
}

/** 文本输入的 ch 宽度（短字段 12ch、路径/URL 32ch、备注 48ch）。 */
export function inputCh(key: string): number {
  if (/(url|path|ref_audio|file|dir)/i.test(key)) return 32;
  if (/(text|instructions|prompt|note|desc)/i.test(key)) return 48;
  return 12;
}
