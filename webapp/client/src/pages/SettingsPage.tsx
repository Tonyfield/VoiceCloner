import { Button, theme } from "antd";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "../theme";
import { textOnPrimary } from "../themes";
import { useI18n } from "../i18n";
import DisplaySettingsPage from "./DisplaySettingsPage";
import UserSettingsPage from "./UserSettingsPage";

/** 设置页：左侧子导航（显示/账号）+ 右侧面板。 */
export default function SettingsPage() {
  const { t } = useI18n();
  const { palette } = useTheme();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const items = [
    { key: "display", label: t("settings.display") },
    { key: "account", label: t("nav.settings") },
  ];
  const active = items.find((item) => pathname.startsWith(`/settings/${item.key}`))?.key ?? "display";
  const onPrimary = textOnPrimary(palette.primary);

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      <nav style={{ flex: "0 0 180px", display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((item) => {
          const isActive = item.key === active;
          return (
            <Button
              key={item.key}
              block
              variant="outlined"
              style={{
                textAlign: "left",
                borderColor: isActive ? palette.primary : token.colorBorder,
                background: isActive ? palette.primary : "transparent",
                color: isActive ? onPrimary : undefined,
              }}
              onClick={() => navigate(`/settings/${item.key}`)}
            >
              {item.label}
            </Button>
          );
        })}
      </nav>

      <div style={{ flex: 1, minWidth: 0 }}>
        <Routes>
          <Route index element={<Navigate to="display" replace />} />
          <Route path="display" element={<DisplaySettingsPage />} />
          <Route path="account" element={<UserSettingsPage />} />
          <Route path="*" element={<Navigate to="display" replace />} />
        </Routes>
      </div>
    </div>
  );
}
