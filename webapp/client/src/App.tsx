import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Button, Dropdown, Layout, Menu, Space, Tooltip, Typography } from "antd";
import type { MenuProps } from "antd";
import {
  ApiOutlined,
  AudioOutlined,
  BgColorsOutlined,
  CustomerServiceOutlined,
  FolderOpenOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { useAuth } from "./auth";
import { useTheme } from "./theme";
import { useI18n } from "./i18n";
import type { Messages } from "./i18n/locales";
import { APP_VERSION } from "./version";
import LanguageMenu from "./components/LanguageMenu";
import LoginPage from "./pages/LoginPage";
import TasksPage from "./pages/TasksPage";
import TaskWorkspacePage from "./pages/TaskWorkspacePage";
import ModelsPage from "./pages/ModelsPage";
import VoicesPage from "./pages/VoicesPage";
import SettingsPage from "./pages/SettingsPage";

const { Sider, Content } = Layout;

const SIDER_WIDTH = 240;
const SIDER_COLLAPSED_WIDTH = 64;
const SIDER_COLLAPSED_KEY = "vc_sider_collapsed";

export default function App() {
  const { token, logout } = useAuth();
  const { palette, paletteId, setPaletteId, palettes } = useTheme();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDER_COLLAPSED_KEY) === "1"
  );

  useEffect(() => {
    localStorage.setItem(SIDER_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  if (!token) return <LoginPage />;

  const menuItems: MenuProps["items"] = [
    { key: "tasks", icon: <FolderOpenOutlined />, label: t("nav.tasks") },
    {
      type: "group",
      label: t("nav.groupResources"),
      children: [
        { key: "models", icon: <ApiOutlined />, label: t("nav.models") },
        { key: "voices", icon: <CustomerServiceOutlined />, label: t("nav.voices") },
      ],
    },
  ];

  // 导航高亮由路由派生；用户设置在底栏单独高亮。
  const selected = pathname.startsWith("/models")
    ? "models"
    : pathname.startsWith("/voices")
      ? "voices"
      : "tasks";
  const settingsActive = pathname.startsWith("/settings");

  const settingsButton = (
    <Button
      block={!collapsed}
      type={settingsActive ? "primary" : "default"}
      icon={<SettingOutlined />}
      onClick={() => navigate("/settings")}
    >
      {collapsed ? null : t("nav.settings")}
    </Button>
  );

  return (
    <Layout style={{ height: "100vh", overflow: "hidden" }}>
      <Sider
        width={SIDER_WIDTH}
        collapsedWidth={SIDER_COLLAPSED_WIDTH}
        collapsed={collapsed}
        trigger={null}
        theme={palette.dark ? "dark" : "light"}
        className="sider"
      >
        <div
          className="brand-card"
          style={{
            height: 56,
            padding: collapsed ? "8px 0" : "8px 16px",
            justifyContent: collapsed ? "center" : "flex-start",
          }}
        >
          {!collapsed && <AudioOutlined style={{ fontSize: 22, color: palette.primary }} />}
          {!collapsed && <Typography.Text strong>VoiceCloner</Typography.Text>}
          {!collapsed && <div style={{ flex: 1 }} />}
          <Tooltip title={collapsed ? t("act.expand") : t("act.collapse")} placement="right">
            <Button
              type="text"
              size="small"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? t("act.expand") : t("act.collapse")}
            />
          </Tooltip>
        </div>
        <Menu
          mode="inline"
          inlineCollapsed={collapsed}
          selectedKeys={[selected]}
          items={menuItems}
          onClick={({ key }) => navigate(`/${key}`)}
          style={{ borderInlineEnd: "none" }}
        />
        <div
          className="sider-footer"
          style={{ position: "absolute", bottom: 16, left: collapsed ? 6 : 16, right: collapsed ? 6 : 16 }}
        >
          <Space direction="vertical" style={{ width: "100%" }} size={8}>
            {collapsed ? (
              <Tooltip title={t("nav.settings")} placement="right">
                {settingsButton}
              </Tooltip>
            ) : (
              settingsButton
            )}
            <div style={{ display: "flex", gap: 8, flexDirection: collapsed ? "column" : "row" }}>
              <LanguageMenu style={{ flex: 1 }} />
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: palettes.map((themeOption) => ({
                    key: themeOption.id,
                    label: t(`theme.${themeOption.id}.name` as keyof Messages),
                  })),
                  selectable: true,
                  selectedKeys: [paletteId],
                  onClick: ({ key }) => setPaletteId(key),
                }}
              >
                <Tooltip title={t(`theme.${palette.id}.name` as keyof Messages)} placement="right">
                  <Button style={{ flex: 1 }} icon={<BgColorsOutlined />} />
                </Tooltip>
              </Dropdown>
              <Tooltip title={t("nav.logout")} placement="right">
                <Button style={{ flex: 1 }} icon={<LogoutOutlined />} onClick={logout} aria-label="logout" />
              </Tooltip>
            </div>
            {!collapsed && (
              <Typography.Text
                type="secondary"
                style={{ display: "block", textAlign: "center", fontSize: 12 }}
              >
                v{APP_VERSION}
              </Typography.Text>
            )}
          </Space>
        </div>
      </Sider>
      <Content className="content-area">
        <Routes>
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TaskWorkspacePage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/voices" element={<VoicesPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/tasks" replace />} />
        </Routes>
      </Content>
    </Layout>
  );
}
