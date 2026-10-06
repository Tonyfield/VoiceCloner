import type { CSSProperties } from "react";
import { Button, Dropdown, Tooltip, type MenuProps } from "antd";
import { GlobalOutlined } from "@ant-design/icons";
import { countryName, flagUrl, groupedLocales, useI18n } from "../i18n";

/** 小地球按钮：点击展开按语种分组的国别菜单，切换界面语种。 */
export default function LanguageMenu({ style }: { style?: CSSProperties }) {
  const { locale, localeId, setLocaleId } = useI18n();

  const items: MenuProps["items"] = groupedLocales(localeId, locale.pack).map((group) => ({
    type: "group",
    key: `group-${group.lang}`,
    label: group.label,
    children: group.locales.map((item) => ({
      key: item.id,
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <img
            src={flagUrl(item)}
            alt=""
            width={18}
            height={18}
            style={{ borderRadius: "50%", display: "block" }}
          />
          <span>{countryName(locale.pack, item.country)}</span>
        </span>
      ),
    })),
  }));

  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        items,
        selectable: true,
        selectedKeys: [localeId],
        onClick: ({ key }) => setLocaleId(key),
      }}
    >
      <Tooltip title={countryName(locale.pack, locale.country)}>
        <Button style={style} icon={<GlobalOutlined />} aria-label="language" />
      </Tooltip>
    </Dropdown>
  );
}
