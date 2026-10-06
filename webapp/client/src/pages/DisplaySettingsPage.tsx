import { Segmented, Select, Tag, theme, Typography } from "antd";
import { useTheme, FONT_SCALES, fontsForPack } from "../theme";
import { backgroundContrastingWith, textOnColor, themeSwatches } from "../themes";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n/locales";
import LanguageSelect from "../components/LanguageSelect";
import SettingsCard from "../components/settings/SettingsCard";

/** 显示设置：语言、主题配色、界面字体、字号。 */
export default function DisplaySettingsPage() {
  const { t, locale } = useI18n();
  const {
    paletteId,
    setPaletteId,
    palettes,
    fontScale,
    setFontScale,
    fontFamilyId,
    setFontFamilyId,
  } = useTheme();
  const { token } = theme.useToken();

  return (
    <div>
      <Typography.Title level={4} className="page-title">
        {t("settings.display")}
      </Typography.Title>

      <SettingsCard
        title={t("pref.language")}
        subtitle={t("pref.languageHint")}
        style={{ marginBottom: 16 }}
      >
        <LanguageSelect />
      </SettingsCard>

      <SettingsCard
        title={t("settings.theme")}
        subtitle={t("settings.themeHint")}
        style={{ marginBottom: 16 }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          {palettes.map((themeOption) => {
            const active = themeOption.id === paletteId;
            // 选中卡片背景与「第一个色块（主色）」保持足够对比，避免主色块淹没在选中底色里。
            const cardBg = active
              ? backgroundContrastingWith(themeOption.primary, token.colorPrimaryBg, 3)
              : "transparent";
            const cardFg = active ? textOnColor(cardBg) : undefined;
            return (
              <div
                key={themeOption.id}
                onClick={() => setPaletteId(themeOption.id)}
                style={{
                  cursor: "pointer",
                  borderRadius: 12,
                  padding: 10,
                  border: `1px solid ${active ? themeOption.primary : token.colorBorder}`,
                  background: cardBg,
                  color: cardFg,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <Typography.Text strong style={{ color: cardFg }}>
                    {t(`theme.${themeOption.id}.name` as keyof Messages)}
                  </Typography.Text>
                  {active && <Tag color="blue">{t("settings.current")}</Tag>}
                </div>
                <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
                  {themeSwatches(themeOption).map((color, i) => (
                    <span
                      key={`${color}-${i}`}
                      title={color}
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 4,
                        background: color,
                        border: `1px solid ${token.colorBorder}`,
                      }}
                    />
                  ))}
                </div>
                <Typography.Text
                  type={active ? undefined : "secondary"}
                  style={{ fontSize: 12, color: cardFg, opacity: active ? 0.85 : undefined }}
                >
                  {t("settings.usage", {
                    usage: t(`theme.${themeOption.id}.usage` as keyof Messages),
                  })}
                </Typography.Text>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard
        title={t("pref.fontFamily")}
        subtitle={t("pref.fontFamilyHint")}
        style={{ marginBottom: 16 }}
      >
        <Select
          value={fontFamilyId}
          onChange={(value) => setFontFamilyId(value)}
          style={{ width: 240 }}
          options={fontsForPack(locale.pack).map((font) => ({
            value: font.id,
            label: t(font.labelKey as keyof Messages),
            // 选项预览用该字体本身渲染
            style: { fontFamily: font.stack },
          }))}
        />
      </SettingsCard>

      <SettingsCard title={t("pref.fontSize")} subtitle={t("pref.fontSizeHint")}>
        <Segmented
          value={fontScale}
          onChange={(value) => setFontScale(Number(value))}
          options={FONT_SCALES.map((scale) => ({
            label: `${Math.round(scale * 100)}%`,
            value: scale,
          }))}
        />
      </SettingsCard>
    </div>
  );
}
