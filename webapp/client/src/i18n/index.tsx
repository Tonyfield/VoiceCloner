import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  LOCALES,
  STATIC_MESSAGES,
  findLocale,
  loadMessages,
  matchSystemLocale,
  type LocaleDef,
  type Messages,
} from "./locales";

const LOCALE_KEY = "vc_locale";

type MessageKey = keyof Messages;

interface I18nValue {
  /** 当前国别/语言 */
  locale: LocaleDef;
  localeId: string;
  setLocaleId: (id: string) => void;
  /** 全部可选国别（选择器用） */
  locales: LocaleDef[];
  /** 取当前语种文案；缺失依次回退 英文 → key 本身 */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

/** 首次进入：已保存的选择优先，否则跟随系统语言。 */
function readLocaleId(): string {
  const stored = localStorage.getItem(LOCALE_KEY);
  if (stored) return findLocale(stored).id;
  const system = typeof navigator === "undefined" ? undefined : navigator.language;
  return matchSystemLocale(system).id;
}

/** 该 locale 的常驻文案包（不在常驻表中则回退英文），用于首屏同步渲染。 */
function staticPack(localeId: string): Messages {
  const locale = findLocale(localeId);
  return STATIC_MESSAGES[locale.pack] ?? STATIC_MESSAGES.en!;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [localeId, setLocaleIdState] = useState<string>(() => readLocaleId());
  const [pack, setPack] = useState<Messages>(() => staticPack(readLocaleId()));

  const setLocaleId = useCallback((id: string) => setLocaleIdState(findLocale(id).id), []);

  // 切换语种：常驻包立即生效；其余先回退英文，按需加载完成后再替换。
  useEffect(() => {
    const locale = findLocale(localeId);
    const stat = STATIC_MESSAGES[locale.pack];
    if (stat) {
      setPack(stat);
      return;
    }
    let cancelled = false;
    setPack(STATIC_MESSAGES.en!);
    void loadMessages(locale.pack).then((loaded) => {
      if (!cancelled) setPack(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [localeId]);

  const value = useMemo<I18nValue>(() => {
    const locale = findLocale(localeId);
    const english = STATIC_MESSAGES.en!;

    const t = (key: MessageKey, vars?: Record<string, string | number>) => {
      const template = pack[key] ?? english[key] ?? String(key);
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (_, name: string) =>
        vars[name] === undefined ? `{${name}}` : String(vars[name])
      );
    };

    return { locale, localeId: locale.id, setLocaleId, locales: LOCALES, t };
  }, [localeId, pack, setLocaleId]);

  // 同步 localStorage / <html lang> / 书写方向（阿拉伯语为 RTL）
  useEffect(() => {
    localStorage.setItem(LOCALE_KEY, value.localeId);
    document.documentElement.lang = value.locale.id;
    document.documentElement.dir = value.locale.rtl ? "rtl" : "ltr";
  }, [value.localeId, value.locale.id, value.locale.rtl]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

export { flagUrl, countryName, findLocale, groupedLocales, languageName } from "./locales";
export type { LocaleDef, LocaleGroup } from "./locales";
