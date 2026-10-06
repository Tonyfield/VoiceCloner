/**
 * UI 国际化：国别（国旗）→ 语言映射、按当前语种显示的国名、以及核心文案字典。
 *
 * - 选择器展示「国旗 + 国名（以当前语种显示）」；
 * - 每个国别对应一种语言的文案实现（同语言的国家复用同一份文案，如 UK/Jamaica → English）；
 * - 未翻译的 key 依次回退：当前语种 → 英文 → 基础中文（见 i18n/index.tsx）。
 */

import zhCN from "./packs/zh-CN";
import en from "./packs/en";

export type CountryCode =
  | "cn" | "tw" | "hk" | "us" | "gb" | "jm" | "in" | "jp"
  | "kr" | "fr" | "de" | "mx" | "br" | "ru" | "vi" | "mr"
  | "es" | "sa" | "it";

/** 语种（ISO 639-1）：同语种的不同国别在选择器里归为一组。 */
export type LangCode =
  | "zh" | "en" | "ja" | "ko" | "fr" | "de" | "es" | "pt" | "ru" | "vi" | "hi" | "ar" | "it";

export interface LocaleDef {
  /** 唯一 id（= BCP-47 语言标记，用于 <html lang> 与持久化） */
  id: string;
  country: CountryCode;
  /** 语种（ISO 639-1） */
  lang: LangCode;
  /** 语言文案包 key（同语言国家复用） */
  pack: MessagePack;
  /** public/country_flag 下的国旗文件 */
  flag: string;
  /** 是否从右到左排版 */
  rtl?: boolean;
}

export const LOCALES: LocaleDef[] = [
  { id: "zh-CN", country: "cn", lang: "zh", pack: "zh-CN", flag: "china-flag-circular-17757.svg" },
  { id: "zh-TW", country: "tw", lang: "zh", pack: "zh-TW", flag: "taiwan-flag-circular-24546.svg" },
  { id: "zh-HK", country: "hk", lang: "zh", pack: "zh-TW", flag: "hong-kong-flag-circle-round-25521.svg" },
  { id: "en-US", country: "us", lang: "en", pack: "en", flag: "usa-flag-circular-17882.svg" },
  { id: "en-GB", country: "gb", lang: "en", pack: "en", flag: "uk-flag-circular-17883.svg" },
  { id: "en-JM", country: "jm", lang: "en", pack: "en", flag: "jamaica-flag-circular-17804.svg" },
  { id: "ja-JP", country: "jp", lang: "ja", pack: "ja", flag: "japan-flag-circular-17764.svg" },
  { id: "ko-KR", country: "kr", lang: "ko", pack: "ko", flag: "south-korea-flag-circular-17853.svg" },
  { id: "fr-FR", country: "fr", lang: "fr", pack: "fr", flag: "france-flag-circular-17753.svg" },
  { id: "de-DE", country: "de", lang: "de", pack: "de", flag: "germany-flag-circular-17755.svg" },
  { id: "es-MX", country: "mx", lang: "es", pack: "es", flag: "mexico-flag-circular-17845.svg" },
  { id: "es-ES", country: "es", lang: "es", pack: "es", flag: "spain-flag-circular-17884.svg" },
  { id: "pt-BR", country: "br", lang: "pt", pack: "pt", flag: "brazil-flag-circular-17847.svg" },
  { id: "ru-RU", country: "ru", lang: "ru", pack: "ru", flag: "russia-flag-circular-17765.svg" },
  { id: "vi-VN", country: "vi", lang: "vi", pack: "vi", flag: "vietnam-flag-circular-17769.svg" },
  { id: "hi-IN", country: "in", lang: "hi", pack: "hi", flag: "india-flag-circular-17791.svg" },
  { id: "ar-MR", country: "mr", lang: "ar", pack: "ar", flag: "mauritania-flag-circular-17817.svg", rtl: true },
  { id: "ar-SA", country: "sa", lang: "ar", pack: "ar", flag: "saudi-arabia-circle-rounded-flag-24368.svg", rtl: true },
  { id: "it-IT", country: "it", lang: "it", pack: "it", flag: "italy-flag-circular-17751.svg" },
];

export const DEFAULT_LOCALE_ID = "zh-CN";

export function findLocale(id: string | null | undefined): LocaleDef {
  return LOCALES.find((locale) => locale.id === id) ?? LOCALES.find((l) => l.id === DEFAULT_LOCALE_ID)!;
}

/** 按系统语言（navigator.language）匹配最接近的国别。 */
export function matchSystemLocale(systemLanguage: string | undefined): LocaleDef {
  const tag = (systemLanguage || "").toLowerCase();
  if (!tag) return findLocale(DEFAULT_LOCALE_ID);
  const exact = LOCALES.find((l) => l.id.toLowerCase() === tag);
  if (exact) return exact;
  const language = tag.split("-")[0];
  // 繁体优先按地区区分，其余按语言匹配
  if (language === "zh") return findLocale(tag.includes("tw") || tag.includes("hk") ? "zh-TW" : "zh-CN");
  return LOCALES.find((l) => l.id.toLowerCase().startsWith(language + "-")) ?? findLocale(DEFAULT_LOCALE_ID);
}

export function flagUrl(locale: LocaleDef): string {
  return `/country_flag/${locale.flag}`;
}

// ---------- 国名（按当前语种显示） ----------

const COUNTRY_NAMES: Record<MessagePack, Record<CountryCode, string>> = {
  "zh-CN": {
    cn: "中国", tw: "中国台湾", hk: "中国香港", us: "美国", gb: "英国", jm: "牙买加",
    in: "印度", jp: "日本", kr: "韩国", fr: "法国", de: "德国", mx: "墨西哥",
    br: "巴西", ru: "俄罗斯", vi: "越南", mr: "毛里塔尼亚",
    es: "西班牙", sa: "沙特阿拉伯", it: "意大利",
  },
  "zh-TW": {
    cn: "中國", tw: "中國台灣", hk: "中國香港", us: "美國", gb: "英國", jm: "牙買加",
    in: "印度", jp: "日本", kr: "韓國", fr: "法國", de: "德國", mx: "墨西哥",
    br: "巴西", ru: "俄羅斯", vi: "越南", mr: "茅利塔尼亞",
    es: "西班牙", sa: "沙烏地阿拉伯", it: "義大利",
  },
  en: {
    cn: "China", tw: "Taiwan", hk: "Hong Kong", us: "United States", gb: "United Kingdom",
    jm: "Jamaica", in: "India", jp: "Japan", kr: "South Korea", fr: "France", de: "Germany",
    mx: "Mexico", br: "Brazil", ru: "Russia", vi: "Vietnam", mr: "Mauritania",
    es: "Spain", sa: "Saudi Arabia", it: "Italy",
  },
  ja: {
    cn: "中国", tw: "台湾", hk: "香港", us: "アメリカ", gb: "イギリス", jm: "ジャマイカ",
    in: "インド", jp: "日本", kr: "韓国", fr: "フランス", de: "ドイツ", mx: "メキシコ",
    br: "ブラジル", ru: "ロシア", vi: "ベトナム", mr: "モーリタニア",
    es: "スペイン", sa: "サウジアラビア", it: "イタリア",
  },
  ko: {
    cn: "중국", tw: "대만", hk: "홍콩", us: "미국", gb: "영국", jm: "자메이카",
    in: "인도", jp: "일본", kr: "대한민국", fr: "프랑스", de: "독일", mx: "멕시코",
    br: "브라질", ru: "러시아", vi: "베트남", mr: "모리타니",
    es: "스페인", sa: "사우디아라비아", it: "이탈리아",
  },
  fr: {
    cn: "Chine", tw: "Taïwan", hk: "Hong Kong", us: "États-Unis", gb: "Royaume-Uni",
    jm: "Jamaïque", in: "Inde", jp: "Japon", kr: "Corée du Sud", fr: "France", de: "Allemagne",
    mx: "Mexique", br: "Brésil", ru: "Russie", vi: "Viêt Nam", mr: "Mauritanie",
    es: "Espagne", sa: "Arabie saoudite", it: "Italie",
  },
  de: {
    cn: "China", tw: "Taiwan", hk: "Hongkong", us: "Vereinigte Staaten", gb: "Vereinigtes Königreich",
    jm: "Jamaika", in: "Indien", jp: "Japan", kr: "Südkorea", fr: "Frankreich", de: "Deutschland",
    mx: "Mexiko", br: "Brasilien", ru: "Russland", vi: "Vietnam", mr: "Mauretanien",
    es: "Spanien", sa: "Saudi-Arabien", it: "Italien",
  },
  es: {
    cn: "China", tw: "Taiwán", hk: "Hong Kong", us: "Estados Unidos", gb: "Reino Unido",
    jm: "Jamaica", in: "India", jp: "Japón", kr: "Corea del Sur", fr: "Francia", de: "Alemania",
    mx: "México", br: "Brasil", ru: "Rusia", vi: "Vietnam", mr: "Mauritania",
    es: "España", sa: "Arabia Saudí", it: "Italia",
  },
  pt: {
    cn: "China", tw: "Taiwan", hk: "Hong Kong", us: "Estados Unidos", gb: "Reino Unido",
    jm: "Jamaica", in: "Índia", jp: "Japão", kr: "Coreia do Sul", fr: "França", de: "Alemanha",
    mx: "México", br: "Brasil", ru: "Rússia", vi: "Vietnã", mr: "Mauritânia",
    es: "Espanha", sa: "Arábia Saudita", it: "Itália",
  },
  ru: {
    cn: "Китай", tw: "Тайвань", hk: "Гонконг", us: "США", gb: "Великобритания",
    jm: "Ямайка", in: "Индия", jp: "Япония", kr: "Южная Корея", fr: "Франция", de: "Германия",
    mx: "Мексика", br: "Бразилия", ru: "Россия", vi: "Вьетнам", mr: "Мавритания",
    es: "Испания", sa: "Саудовская Аравия", it: "Италия",
  },
  vi: {
    cn: "Trung Quốc", tw: "Đài Loan", hk: "Hồng Kông", us: "Hoa Kỳ", gb: "Vương quốc Anh",
    jm: "Jamaica", in: "Ấn Độ", jp: "Nhật Bản", kr: "Hàn Quốc", fr: "Pháp", de: "Đức",
    mx: "Mexico", br: "Brazil", ru: "Nga", vi: "Việt Nam", mr: "Mauritanie",
    es: "Tây Ban Nha", sa: "Ả Rập Xê Út", it: "Ý",
  },
  hi: {
    cn: "चीन", tw: "ताइवान", hk: "हांगकांग", us: "अमेरिका", gb: "ब्रिटेन",
    jm: "जमैका", in: "भारत", jp: "जापान", kr: "दक्षिण कोरिया", fr: "फ़्रांस", de: "जर्मनी",
    mx: "मेक्सिको", br: "ब्राज़ील", ru: "रूस", vi: "वियतनाम", mr: "मॉरिटानिया",
    es: "स्पेन", sa: "सऊदी अरब", it: "इटली",
  },
  ar: {
    cn: "الصين", tw: "تايوان", hk: "هونغ كونغ", us: "الولايات المتحدة", gb: "المملكة المتحدة",
    jm: "جامايكا", in: "الهند", jp: "اليابان", kr: "كوريا الجنوبية", fr: "فرنسا", de: "ألمانيا",
    mx: "المكسيك", br: "البرازيل", ru: "روسيا", vi: "فيتنام", mr: "موريتانيا",
    es: "إسبانيا", sa: "السعودية", it: "إيطاليا",
  },
  it: {
    cn: "Cina", tw: "Taiwan", hk: "Hong Kong", us: "Stati Uniti", gb: "Regno Unito",
    jm: "Giamaica", in: "India", jp: "Giappone", kr: "Corea del Sud", fr: "Francia", de: "Germania",
    mx: "Messico", br: "Brasile", ru: "Russia", vi: "Vietnam", mr: "Mauritania",
    es: "Spagna", sa: "Arabia Saudita", it: "Italia",
  },
};

/** 国名（以当前语种显示），缺失时回退英文。 */
export function countryName(pack: MessagePack, country: CountryCode): string {
  return COUNTRY_NAMES[pack]?.[country] ?? COUNTRY_NAMES.en[country] ?? country;
}

// ---------- 语种名（按当前语种显示） ----------

const LANGUAGE_NAMES: Partial<Record<MessagePack, Record<LangCode, string>>> = {
  "zh-CN": {
    zh: "汉语", en: "英语", ja: "日语", ko: "韩语", fr: "法语", de: "德语",
    es: "西班牙语", pt: "葡萄牙语", ru: "俄语", vi: "越南语", hi: "印地语",
    ar: "阿拉伯语", it: "意大利语",
  },
  "zh-TW": {
    zh: "漢語", en: "英語", ja: "日語", ko: "韓語", fr: "法語", de: "德語",
    es: "西班牙語", pt: "葡萄牙語", ru: "俄語", vi: "越南語", hi: "印地語",
    ar: "阿拉伯語", it: "義大利語",
  },
  en: {
    zh: "Chinese", en: "English", ja: "Japanese", ko: "Korean", fr: "French", de: "German",
    es: "Spanish", pt: "Portuguese", ru: "Russian", vi: "Vietnamese", hi: "Hindi",
    ar: "Arabic", it: "Italian",
  },
};

/** 语种名（以当前语种显示），缺失时回退英文。 */
export function languageName(pack: MessagePack, lang: LangCode): string {
  return LANGUAGE_NAMES[pack]?.[lang] ?? LANGUAGE_NAMES.en![lang] ?? lang;
}

// ---------- 分组（按语种） ----------

export interface LocaleGroup {
  lang: LangCode;
  label: string;
  locales: LocaleDef[];
}

/**
 * 国别按语种分组：组按当前界面语言下的语种名 A–Z 排序，组内按国家 ISO 码升序，
 * 当前语言组置顶（组内当前 locale 放首位）。
 */
export function groupedLocales(currentLocaleId: string, pack: MessagePack): LocaleGroup[] {
  const byLang = new Map<LangCode, LocaleDef[]>();
  for (const locale of LOCALES) {
    const list = byLang.get(locale.lang);
    if (list) list.push(locale);
    else byLang.set(locale.lang, [locale]);
  }

  const groups: LocaleGroup[] = [...byLang.entries()].map(([lang, items]) => ({
    lang,
    label: languageName(pack, lang),
    locales: [...items].sort((a, b) => a.country.localeCompare(b.country)),
  }));

  const collator = new Intl.Collator(currentLocaleId || "en", { sensitivity: "base" });
  groups.sort((a, b) => collator.compare(a.label, b.label));

  const current = findLocale(currentLocaleId);
  const index = groups.findIndex((group) => group.lang === current.lang);
  if (index > 0) {
    const [pinned] = groups.splice(index, 1);
    groups.unshift(pinned);
  }

  const currentGroup = groups.find((group) => group.lang === current.lang);
  if (currentGroup) {
    const at = currentGroup.locales.findIndex((locale) => locale.id === current.id);
    if (at > 0) {
      const [entry] = currentGroup.locales.splice(at, 1);
      currentGroup.locales.unshift(entry);
    }
  }

  return groups;
}

// ---------- 核心文案 ----------

/** 语言包：允许按批次增量补齐，缺失的 key 由 t() 依次回退（英文 → key）。 */
export type MessageKey = keyof typeof zhCN;
export type Messages = Partial<Record<MessageKey, string>>;

export type MessagePack =
  | "zh-CN" | "zh-TW" | "en" | "ja" | "ko" | "fr" | "de" | "es" | "pt" | "ru" | "vi" | "hi" | "ar"
  | "it";

/** 常驻（首屏同步可用）的语言包：中文为源语言，英文为兜底回退。 */
export const STATIC_MESSAGES: Partial<Record<MessagePack, Messages>> = {
  "zh-CN": zhCN as Messages,
  en,
};

const LAZY_PACKS: Partial<Record<MessagePack, () => Promise<{ default: Messages }>>> = {
  "zh-TW": () => import("./packs/zh-TW"),
  ja: () => import("./packs/ja"),
  ko: () => import("./packs/ko"),
  fr: () => import("./packs/fr"),
  de: () => import("./packs/de"),
  es: () => import("./packs/es"),
  pt: () => import("./packs/pt"),
  ru: () => import("./packs/ru"),
  vi: () => import("./packs/vi"),
  hi: () => import("./packs/hi"),
  ar: () => import("./packs/ar"),
  it: () => import("./packs/it"),
};

/** 按需加载语言包：常驻包同步返回，其余动态 import；失败回退英文。 */
export async function loadMessages(pack: MessagePack): Promise<Messages> {
  const stat = STATIC_MESSAGES[pack];
  if (stat) return stat;
  const loader = LAZY_PACKS[pack];
  if (!loader) return en;
  try {
    const mod = await loader();
    return mod.default ?? en;
  } catch {
    return en;
  }
}
