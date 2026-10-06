import { useEffect, useMemo, useState, type CSSProperties } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider, theme as antdTheme } from "antd";
import App from "./App";
import { AuthProvider } from "./auth";
import { ThemeProvider, useTheme, findFontFamily, fontGroupForPack } from "./theme";
import { ensureFontsLoaded } from "./fonts";
import { I18nProvider, useI18n } from "./i18n";
import { DEFAULT_ANTD_LOCALE, loadAntdLocale } from "./i18n/antdLocale";
import { textOnPrimary, textPrimaryOn } from "./themes";
import "./index.css";

function ThemedApp() {
  const { palette, fontScale, fontFamilyId, setFontFamilyId } = useTheme();
  const fontFamily = findFontFamily(fontFamilyId);
  const { locale } = useI18n();
  // antd 组件内置文案按需加载：默认中文，切换到其他语种时再拉取对应语言包。
  const [antdLocale, setAntdLocale] = useState(DEFAULT_ANTD_LOCALE);
  useEffect(() => {
    let cancelled = false;
    void loadAntdLocale(locale.pack).then((loaded) => {
      if (!cancelled) setAntdLocale(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [locale.pack]);
  // 实心主色上的文字：按对比度选择黑/白，避免浅色主题下按钮文字看不清
  const onPrimary = textOnPrimary(palette.primary);
  // 主色作为「背景上的文字/描边」（链接、选中态、outlined 按钮文字）时的安全色
  const primaryText = textPrimaryOn(palette.surface, palette.primary);
  // 错误/危险色：按对比度调整（留余量，抵消深色算法的派生）
  const errorColor = textPrimaryOn(palette.surface, "#FF4D4F", 6.2);
  // Tooltip 气泡：antd 默认固定黑底（colorBgSpotlight），改为跟随主题——
  // 浅色主题用主题文字色作底 + 主题背景色作字；深色主题用主题表面色作底 + 主题文字色作字。
  const tooltipBg = palette.dark ? palette.surface : palette.text;
  const tooltipFg = palette.dark ? palette.text : palette.background;

  // 主题 CSS 变量：同时挂到 :root —— Modal / Drawer / Tooltip 等经 portal 渲染到 body，
  // 不在本组件的 div 内，挂到 :root 才能让这些弹层也跟随主题（否则会回退到浅色默认值）。
  const vars = useMemo(
    () =>
      ({
        "--vc-bg": palette.background,
        "--vc-surface": palette.surface,
        "--vc-text": palette.text,
        "--vc-muted": palette.muted,
        "--vc-primary": palette.primary,
        "--vc-primary-text": primaryText,
        "--vc-on-primary": onPrimary,
        "--vc-accent": palette.accent ?? palette.primary,
        "--vc-error": errorColor,
        "--vc-border": palette.dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.08)",
        "--vc-code-bg": palette.dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.035)",
        "--vc-code-text": palette.dark ? "rgba(255,255,255,0.78)" : "rgba(0,0,0,0.72)",
        "--vc-font": fontFamily.stack,
      }) as CSSProperties,
    [palette, primaryText, onPrimary, errorColor, fontFamily.stack]
  );

  useEffect(() => {
    const root = document.documentElement;
    const entries = Object.entries(vars) as Array<[string, string]>;
    for (const [key, value] of entries) {
      if (value !== undefined && value !== null) root.style.setProperty(key, String(value));
    }
    return () => {
      for (const [key] of entries) root.style.removeProperty(key);
    };
  }, [vars]);

  // 字号设置：同步 antd token（见下）与根字号，作用于 antd 组件及 rem 文本。
  useEffect(() => {
    document.documentElement.style.fontSize = `${Math.round(16 * fontScale)}px`;
    return () => {
      document.documentElement.style.fontSize = "";
    };
  }, [fontScale]);

  // 按界面语种加载对应字体组；已选字体若不属于当前语种分组则回退系统默认。
  useEffect(() => {
    const group = fontGroupForPack(locale.pack);
    void ensureFontsLoaded(group);
    const current = findFontFamily(fontFamilyId);
    if (current.group !== "system" && current.group !== group) setFontFamilyId("system");
  }, [locale.pack, fontFamilyId, setFontFamilyId]);

  return (
    <ConfigProvider
      locale={antdLocale}
      direction={locale.rtl ? "rtl" : "ltr"}
      theme={{
        algorithm: palette.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          fontFamily: fontFamily.stack,
          fontSize: Math.round(14 * fontScale),
          fontSizeSM: Math.round(12 * fontScale),
          fontSizeLG: Math.round(16 * fontScale),
          fontSizeXL: Math.round(20 * fontScale),
          colorPrimary: palette.primary,
          colorInfo: palette.primary,
          colorLink: primaryText,
          // 注意：不要覆盖全局 colorTextLightSolid。它是「深色/实心表面上的文字」的统一 token，
          // Tooltip(气泡)、Badge 等都依赖它；覆盖成 onPrimary 会让浅色主色主题下气泡文字变黑不可读。
          // 实心主按钮的文字色改由 Button 组件 token primaryColor 精确控制（见下）。
          colorPrimaryText: primaryText,
          // 错误/危险按钮的红色同样按对比度调整（留更高余量，抵消深色算法的派生）
          colorError: errorColor,
          colorBgLayout: palette.background,
          colorBgContainer: palette.surface,
          colorText: palette.text,
          colorTextSecondary: palette.muted,
          // 显式给出可见的控件描边，避免浅色方案下按钮/输入框/下拉框边缘看不清
          colorBorder: palette.dark ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.22)",
          colorBorderSecondary: palette.dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.10)",
          borderRadius: 12,
        },
        // 菜单选中项：统一改为「主色实底 + 对比色文字」，避免浅色主题下
        // 浅色底 + 主色字导致选中项对比度过低（马卡龙/复古/莫兰迪等）。
        components: {
          // 实心主按钮上的文字：按主色对比度选黑/白（仅影响主按钮，不影响 Tooltip 等）。
          Button: { primaryColor: onPrimary },
          // 气泡跟随主题底色/字色（对比度由主题的 文字色↔背景色 保证）。
          Tooltip: { colorBgSpotlight: tooltipBg, colorTextLightSolid: tooltipFg },
          Menu: {
            itemSelectedBg: palette.primary,
            itemSelectedColor: onPrimary,
            darkItemSelectedBg: palette.primary,
            darkItemSelectedColor: onPrimary,
          },
        },
      }}
    >
      <div style={{ ...vars, minHeight: "100vh", background: palette.background, color: palette.text }}>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </div>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <I18nProvider>
      <ThemedApp />
    </I18nProvider>
  </ThemeProvider>
);
