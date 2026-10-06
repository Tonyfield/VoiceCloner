import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_THEME_ID, findTheme, THEMES, type ThemePalette } from "./themes";

const THEME_KEY = "vc_theme";
const FONT_KEY = "vc_font_scale";
const FONT_FAMILY_KEY = "vc_font_family";

/** 可选界面字号倍数（显示设置用）。 */
export const FONT_SCALES = [0.9, 1, 1.15, 1.3] as const;

/** 字体分组：system 通用；其余按界面语种筛选。 */
export type FontGroup = "system" | "latin" | "zh" | "ja";

export interface FontFamilyOption {
  id: string;
  /** 文案 key（见 i18n pack） */
  labelKey: string;
  /** CSS font-family 栈 */
  stack: string;
  group: FontGroup;
}

const SYSTEM_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const CJK_FALLBACK = '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif';

/**
 * 可选界面字体：全部为自托管 OFL 字体（系统默认除外）。
 * 中文字体只在中文界面可选，日文字体只在日文界面可选，其余界面为拉丁字体。
 */
export const FONT_FAMILIES: FontFamilyOption[] = [
  { id: "system", group: "system", labelKey: "font.system", stack: SYSTEM_STACK },
  // 中文
  { id: "noto-sans-sc", group: "zh", labelKey: "font.noto-sans-sc", stack: `"Noto Sans SC", ${CJK_FALLBACK}` },
  { id: "lxgw-wenkai", group: "zh", labelKey: "font.lxgw-wenkai", stack: `"LXGW WenKai", ${CJK_FALLBACK}` },
  { id: "zcool-kuaile", group: "zh", labelKey: "font.zcool-kuaile", stack: `"ZCOOL KuaiLe", ${CJK_FALLBACK}` },
  { id: "zcool-qingke-huangyou", group: "zh", labelKey: "font.zcool-qingke-huangyou", stack: `"ZCOOL QingKe HuangYou", ${CJK_FALLBACK}` },
  { id: "smiley-sans", group: "zh", labelKey: "font.smiley-sans", stack: `"Smiley Sans", ${CJK_FALLBACK}` },
  // 日文
  { id: "m-plus-rounded-1c", group: "ja", labelKey: "font.m-plus-rounded-1c", stack: `"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Yu Gothic", ${CJK_FALLBACK}` },
  { id: "zen-maru-gothic", group: "ja", labelKey: "font.zen-maru-gothic", stack: `"Zen Maru Gothic", "Hiragino Maru Gothic ProN", "Yu Gothic", ${CJK_FALLBACK}` },
  // 拉丁
  { id: "nunito", group: "latin", labelKey: "font.nunito", stack: `"Nunito", ${SYSTEM_STACK}` },
  { id: "quicksand", group: "latin", labelKey: "font.quicksand", stack: `"Quicksand", ${SYSTEM_STACK}` },
  { id: "baloo-2", group: "latin", labelKey: "font.baloo-2", stack: `"Baloo 2", ${SYSTEM_STACK}` },
  { id: "fredoka", group: "latin", labelKey: "font.fredoka", stack: `"Fredoka", ${SYSTEM_STACK}` },
];

export function findFontFamily(id: string | null | undefined): FontFamilyOption {
  return FONT_FAMILIES.find((font) => font.id === id) ?? FONT_FAMILIES[0];
}

/** 界面语种（pack）→ 字体分组：中文包 → zh，日文包 → ja，其余 → 拉丁。 */
export function fontGroupForPack(pack: string): "latin" | "zh" | "ja" {
  if (pack === "zh-CN" || pack === "zh-TW") return "zh";
  if (pack === "ja") return "ja";
  return "latin";
}

/** 该语种下可选的字体：系统默认 + 对应分组的字体。 */
export function fontsForPack(pack: string): FontFamilyOption[] {
  const group = fontGroupForPack(pack);
  return [FONT_FAMILIES[0], ...FONT_FAMILIES.filter((font) => font.group === group)];
}

interface ThemeValue {
  /** 当前配色方案 */
  palette: ThemePalette;
  paletteId: string;
  setPaletteId: (id: string) => void;
  palettes: ThemePalette[];
  /** 便捷：当前是否暗色方案 */
  dark: boolean;
  /** 界面字号倍数 */
  fontScale: number;
  setFontScale: (scale: number) => void;
  /** 界面字体 */
  fontFamilyId: string;
  setFontFamilyId: (id: string) => void;
}

const ThemeContext = createContext<ThemeValue>({
  palette: findTheme(DEFAULT_THEME_ID),
  paletteId: DEFAULT_THEME_ID,
  setPaletteId: () => {},
  palettes: THEMES,
  dark: false,
  fontScale: 1,
  setFontScale: () => {},
  fontFamilyId: FONT_FAMILIES[0].id,
  setFontFamilyId: () => {},
});

/** 读取持久化字号；仅接受预设档位，非法值回退 1。 */
function readFontScale(): number {
  const stored = Number(localStorage.getItem(FONT_KEY));
  return (FONT_SCALES as readonly number[]).includes(stored) ? stored : 1;
}

function clampFontScale(scale: number): number {
  return (FONT_SCALES as readonly number[]).includes(scale) ? scale : 1;
}

/** 读取持久化字体；仅接受已知 id，非法值回退系统默认。 */
function readFontFamilyId(): string {
  return findFontFamily(localStorage.getItem(FONT_FAMILY_KEY)).id;
}

/** 读取持久化的方案；兼容旧值 "light" / "dark"。 */
function readPaletteId(): string {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light") return DEFAULT_THEME_ID;
  if (stored === "dark") return "dark";
  return findTheme(stored).id;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [paletteId, setPaletteIdState] = useState<string>(() => readPaletteId());
  const [fontScale, setFontScaleState] = useState<number>(() => readFontScale());
  const [fontFamilyId, setFontFamilyIdState] = useState<string>(() => readFontFamilyId());

  useEffect(() => {
    localStorage.setItem(THEME_KEY, paletteId);
  }, [paletteId]);

  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontScale));
  }, [fontScale]);

  useEffect(() => {
    localStorage.setItem(FONT_FAMILY_KEY, fontFamilyId);
  }, [fontFamilyId]);

  const setPaletteId = useCallback((id: string) => setPaletteIdState(findTheme(id).id), []);
  const setFontScale = useCallback((scale: number) => setFontScaleState(clampFontScale(scale)), []);
  const setFontFamilyId = useCallback(
    (id: string) => setFontFamilyIdState(findFontFamily(id).id),
    []
  );

  const value = useMemo<ThemeValue>(() => {
    const palette = findTheme(paletteId);
    return {
      palette,
      paletteId: palette.id,
      setPaletteId,
      palettes: THEMES,
      dark: palette.dark,
      fontScale,
      setFontScale,
      fontFamilyId,
      setFontFamilyId,
    };
  }, [paletteId, setPaletteId, fontScale, setFontScale, fontFamilyId, setFontFamilyId]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}
