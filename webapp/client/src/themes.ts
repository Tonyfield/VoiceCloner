/**
 * 界面主题配色方案（用户设置中可选）。
 * 每个方案给出 antd token 所需的：主色 / 辅色 / 强调色 / 页面背景 / 表面色 / 文字。
 * 说明：部分方案原文只给出部分颜色，这里按同色系补齐 surface（卡片底）与 muted（次级文字）。
 */
export interface ThemePalette {
  id: string;
  name: string;
  /** 适用场景说明 */
  usage: string;
  /** 是否暗色主题（决定 antd 算法与 Sider 主题） */
  dark: boolean;
  /** 主色 */
  primary: string;
  /** 辅色 */
  secondary?: string;
  /** 强调色 */
  accent?: string;
  /** 页面背景 */
  background: string;
  /** 卡片/表面背景 */
  surface: string;
  /** 主文字色 */
  text: string;
  /** 次级文字色 */
  muted: string;
  /** 方案中额外列出的颜色（用于设置页色板展示） */
  extras?: string[];
}

export const THEMES: ThemePalette[] = [
  {
    id: "mono",
    name: "极简黑白灰",
    usage: "高端品牌、作品集、工具类 UI",
    dark: false,
    primary: "#111827",
    secondary: "#6B7280",
    accent: "#EF4444",
    background: "#FFFFFF",
    surface: "#F5F5F5",
    text: "#111827",
    muted: "#6B7280",
  },
  {
    id: "tech-blue",
    name: "科技蓝",
    usage: "SaaS、AI、数据后台",
    dark: false,
    primary: "#2563EB",
    secondary: "#0EA5E9",
    accent: "#22D3EE",
    background: "#F8FAFC",
    surface: "#FFFFFF",
    text: "#0F172A",
    muted: "#475569",
  },
  {
    id: "dark",
    name: "暗黑模式",
    usage: "开发者工具、影音、夜间 App",
    dark: true,
    // 参考深色 UI：近黑底 + 靛蓝主色 + 纯白文字，拉开层次、提高对比度
    primary: "#635AFF",
    secondary: "#2A2A33",
    accent: "#8B87FF",
    background: "#0A0A0B",
    surface: "#17171A",
    text: "#FFFFFF",
    muted: "#A6A6B0",
    extras: ["#B9B4FF"],
  },
  {
    id: "morandi",
    name: "莫兰迪低饱和",
    usage: "家居、美妆、文艺品牌",
    dark: false,
    primary: "#8C9A9E",
    secondary: "#B7A99A",
    accent: "#A3B1A1",
    background: "#F1EDE6",
    surface: "#FFFFFF",
    text: "#4A4A4A",
    muted: "#8A8378",
    extras: ["#D8C3A5"],
  },
  {
    id: "macaron",
    name: "马卡龙甜系",
    usage: "儿童、甜品、女性向",
    dark: false,
    primary: "#FFB3BA",
    secondary: "#BAE1FF",
    accent: "#FFFFBA",
    background: "#FFF9F5",
    surface: "#FFFFFF",
    text: "#5A4A4A",
    muted: "#A08B8B",
    extras: ["#FFDFBA", "#BAFFC9"],
  },
  {
    id: "cyberpunk",
    name: "赛博朋克霓虹",
    usage: "游戏、音乐、潮流活动",
    dark: true,
    // 参考赛博朋克视觉：纯黑底 + 霓虹紫主色 + 青蓝辅色 + 纯白文字
    primary: "#B026FF",
    secondary: "#00E5FF",
    accent: "#5CFFFF",
    background: "#050208",
    surface: "#140A22",
    text: "#FFFFFF",
    muted: "#C4B5E0",
    extras: ["#FF2A6D"],
  },
  {
    id: "earth",
    name: "自然大地",
    usage: "环保、农业、户外、咖啡",
    dark: false,
    primary: "#5C6B4A",
    secondary: "#8B5E3C",
    accent: "#D97706",
    background: "#E6D5B8",
    surface: "#F7EEDD",
    text: "#2F3E2E",
    muted: "#5F6B57",
    extras: ["#C2A878"],
  },
  {
    id: "japanese",
    name: "日系清新",
    usage: "生活方式、杂志、餐饮",
    dark: false,
    primary: "#457B9D",
    secondary: "#A8DADC",
    accent: "#E63946",
    background: "#F1FAEE",
    surface: "#FFFFFF",
    text: "#1D3557",
    muted: "#5C7A99",
    extras: ["#D9D2C5"],
  },
  {
    id: "business",
    name: "商务专业",
    usage: "金融、企业官网、报告",
    dark: false,
    primary: "#1E3A8A",
    secondary: "#3B82F6",
    accent: "#F59E0B",
    background: "#FFFFFF",
    surface: "#F9FAFB",
    text: "#111827",
    muted: "#6B7280",
  },
  {
    id: "retro",
    name: "复古撞色",
    usage: "复古海报、咖啡、文创",
    dark: false,
    primary: "#D4A373",
    secondary: "#CCD5AE",
    accent: "#BC6C25",
    background: "#FEFAE0",
    surface: "#FFFFFF",
    text: "#3D405B",
    muted: "#8A7F6A",
    extras: ["#FAEDCD", "#E9EDC9"],
  },
];

export const DEFAULT_THEME_ID = "mono";

export function findTheme(id: string | null | undefined): ThemePalette {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}

// ---------- 对比度：实心主色上的文字颜色 ----------

/** WCAG 相对亮度。 */
function relativeLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 0;
  const value = match[1];
  const linear = [0, 2, 4].map((offset) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG 对比度（1~21）。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 实心主色上的浅色/深色文字候选。 */
export const LIGHT_TEXT_ON_PRIMARY = "#FFFFFF";
export const DARK_TEXT_ON_PRIMARY = "#111827";

/**
 * 实心主色（主按钮、选中态等填充）上对比度更高的文字颜色。
 * 浅色主色（如马卡龙粉、复古棕）用深色字，深色主色用白字，保证可读。
 */
export function textOnPrimary(primary: string): string {
  return contrastRatio(primary, LIGHT_TEXT_ON_PRIMARY) >=
    contrastRatio(primary, DARK_TEXT_ON_PRIMARY)
    ? LIGHT_TEXT_ON_PRIMARY
    : DARK_TEXT_ON_PRIMARY;
}

/** sRGB 通道线性插值（t=0 返回 a，t=1 返回 b）。 */
function mixHex(a: string, b: string, t: number): string {
  const pa = /^#?([0-9a-f]{6})$/i.exec(a.trim());
  const pb = /^#?([0-9a-f]{6})$/i.exec(b.trim());
  if (!pa || !pb) return a;
  const channels = [0, 2, 4].map((offset) => {
    const ca = parseInt(pa[1].slice(offset, offset + 2), 16);
    const cb = parseInt(pb[1].slice(offset, offset + 2), 16);
    return Math.round(ca + (cb - ca) * t)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

/**
 * 主色用作「背景上的文字/描边」（链接、选中态文字、outlined 按钮文字）时的安全色：
 * 与给定背景对比度不足 4.5 时，朝黑（浅色背景）或白（深色背景）方向微调，保持色相。
 */
export function textPrimaryOn(surface: string, primary: string, minRatio = 4.5): string {
  if (contrastRatio(primary, surface) >= minRatio) return primary;
  const toward = relativeLuminance(surface) > 0.5 ? "#000000" : "#FFFFFF";
  let candidate = primary;
  for (let t = 0.1; t <= 1.0001; t += 0.05) {
    candidate = mixHex(primary, toward, t);
    if (contrastRatio(candidate, surface) >= minRatio) return candidate;
  }
  return candidate;
}

/** 任意填充色上的可读文字色（白或近黑，取对比度高者）。 */
export function textOnColor(background: string): string {
  return contrastRatio(background, LIGHT_TEXT_ON_PRIMARY) >= contrastRatio(background, DARK_TEXT_ON_PRIMARY)
    ? LIGHT_TEXT_ON_PRIMARY
    : DARK_TEXT_ON_PRIMARY;
}

/**
 * 让背景 `base` 与目标色块 `target` 至少达到 minRatio 对比度：
 * 不足时朝「与 target 更远」的黑/白方向逐步微调，保证色块在背景上可分辨。
 */
export function backgroundContrastingWith(target: string, base: string, minRatio = 3): string {
  if (contrastRatio(base, target) >= minRatio) return base;
  // 朝黑/白中「能达到更高对比度」的方向微调（中间色调两边的上限差异很大）。
  const toward =
    contrastRatio(target, "#000000") >= contrastRatio(target, "#FFFFFF") ? "#000000" : "#FFFFFF";
  let candidate = base;
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    candidate = mixHex(base, toward, t);
    if (contrastRatio(candidate, target) >= minRatio) return candidate;
  }
  return candidate;
}

/** 设置页展示用的色板：主/辅/强调/表面/文字 + 额外色。 */
export function themeSwatches(palette: ThemePalette): string[] {
  return [
    palette.primary,
    palette.secondary,
    palette.accent,
    palette.surface,
    palette.text,
    ...(palette.extras ?? []),
  ].filter((c): c is string => Boolean(c));
}
