import { Select, type SelectProps } from "antd";
import { countryName, flagUrl, groupedLocales, useI18n } from "../i18n";

/** 国别/语言选择器：按语种分组，国旗 + 国名（以当前语种显示）。 */
export default function LanguageSelect({ width = 220 }: { width?: number }) {
  const { locale, localeId, setLocaleId } = useI18n();

  const options = groupedLocales(localeId, locale.pack).map((group) => ({
    label: group.label,
    options: group.locales.map((item) => {
      const name = countryName(locale.pack, item.country);
      return {
        value: item.id,
        searchText: `${name} ${item.id} ${group.label}`,
        label: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <img
              src={flagUrl(item)}
              alt=""
              width={18}
              height={18}
              style={{ borderRadius: "50%", display: "block" }}
            />
            <span>{name}</span>
          </span>
        ),
      };
    }),
  }));

  return (
    <Select
      value={localeId}
      onChange={(value) => setLocaleId(value)}
      options={options as SelectProps["options"]}
      optionLabelProp="label"
      showSearch
      style={{ width }}
      filterOption={(input, option) =>
        String((option as { searchText?: string } | undefined)?.searchText ?? "")
          .toLowerCase()
          .includes(input.toLowerCase())
      }
    />
  );
}
