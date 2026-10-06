import { useState } from "react";
import { Button, Card, Form, Input, Typography, message } from "antd";
import { AudioOutlined, LockOutlined, UserOutlined } from "@ant-design/icons";
import { useAuth } from "../auth";
import { useI18n } from "../i18n";

export default function LoginPage() {
  const { login } = useAuth();
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      await login(values.username, values.password);
      window.location.href = "/tasks";
    } catch (e: any) {
      message.error(e?.response?.data?.error || t("login.failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // 跟随所选主题：底色用主题背景，左上角一抹主题主色
        background:
          "radial-gradient(circle at 20% 20%, color-mix(in srgb, var(--vc-primary, #6d4cff) 16%, var(--vc-bg, #f6f4fb)) 0%, var(--vc-bg, #f6f4fb) 55%, var(--vc-surface, #eef1ff) 100%)",
      }}
    >
      <Card
        className="flat-card"
        style={{ width: 380, borderRadius: 20 }}
      >
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <AudioOutlined style={{ fontSize: 34, color: "var(--vc-primary-text, #6d4cff)" }} />
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            VoiceCloner
          </Typography.Title>
          <Typography.Text type="secondary">{t("login.subtitle")}</Typography.Text>
        </div>
        <Form layout="vertical" onFinish={onFinish} initialValues={{ username: "admin" }}>
          <Form.Item
            name="username"
            label={t("login.username")}
            rules={[{ required: true, message: t("login.usernameRequired") }]}
          >
            <Input prefix={<UserOutlined />} placeholder="admin" />
          </Form.Item>
          <Form.Item
            name="password"
            label={t("login.password")}
            rules={[{ required: true, message: t("login.passwordRequired") }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="••••••••" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            {t("act.login")}
          </Button>
        </Form>
      </Card>
    </div>
  );
}