import zhCN from "antd/locale/zh_CN";
import type { Locale } from "antd/es/locale";
import type { MessagePack } from "./locales";

/** 首屏默认 antd 语言（与默认文案语言一致，保持同步可用）。 */
export const DEFAULT_ANTD_LOCALE: Locale = zhCN;

/**
 * 语言包 → antd 组件内置文案（分页、日期、空状态等）的按需加载器。
 * 每个 import() 会被打包器拆分为独立 chunk，只在切换到该语种时下载。
 */
const LOADERS: Record<MessagePack, () => Promise<{ default: Locale }>> = {
  "zh-CN": () => import("antd/locale/zh_CN"),
  "zh-TW": () => import("antd/locale/zh_TW"),
  en: () => import("antd/locale/en_US"),
  ja: () => import("antd/locale/ja_JP"),
  ko: () => import("antd/locale/ko_KR"),
  fr: () => import("antd/locale/fr_FR"),
  de: () => import("antd/locale/de_DE"),
  es: () => import("antd/locale/es_ES"),
  pt: () => import("antd/locale/pt_BR"),
  ru: () => import("antd/locale/ru_RU"),
  vi: () => import("antd/locale/vi_VN"),
  hi: () => import("antd/locale/hi_IN"),
  ar: () => import("antd/locale/ar_EG"),
  it: () => import("antd/locale/it_IT"),
};

/** 按需加载 antd 语言包；失败回退默认语言。 */
export async function loadAntdLocale(pack: MessagePack): Promise<Locale> {
  try {
    const mod = await LOADERS[pack]();
    return mod.default ?? DEFAULT_ANTD_LOCALE;
  } catch {
    return DEFAULT_ANTD_LOCALE;
  }
}
