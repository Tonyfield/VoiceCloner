import { useEffect, useState } from "react";
import { Button, Form, Input, Select, Typography, message } from "antd";
import {
  changePassword,
  getPreferences,
  updatePreferences,
  type AudioRetentionMode,
  type UserPreferences,
} from "../api/client";
import { useAuth } from "../auth";
import { useTheme } from "../theme";
import { textPrimaryOn } from "../themes";
import { useI18n } from "../i18n";
import SettingsCard from "../components/settings/SettingsCard";

/** 可选保留期（天）：1周/2周/3周/1个月/3个月/6个月/9个月/12个月。 */
const RETENTION_DAYS = [7, 14, 21, 30, 90, 180, 270, 365];

/** 用户设置：账号信息 + 音频保留偏好 + 修改密码（语言/主题/字号在「显示设置」）。 */
export default function UserSettingsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { palette } = useTheme();
  const primaryText = textPrimaryOn(palette.surface, palette.primary);
  const [saving, setSaving] = useState(false);
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);

  useEffect(() => {
    getPreferences().then(setPrefs).catch((e) => {
      message.error(e?.response?.data?.error || t("settings.saveFailed"));
    });
  }, [t]);

  /** 以周/月展示保留期：7/14/21 → 周，其余 → 月。 */
  const retentionLabel = (days: number) =>
    days < 30 ? `${days / 7}${t("pref.week")}` : `${Math.round(days / 30)}${t("pref.month")}`;

  const savePrefs = async (patch: Partial<UserPreferences>) => {
    try {
      setPrefs(await updatePreferences(patch));
    } catch (e: any) {
      message.error(e?.response?.data?.error || t("settings.saveFailed"));
    }
  };

  const onSave = async (values: { oldPassword: string; newPassword: string }) => {
    setSaving(true);
    try {
      await changePassword(values.oldPassword, values.newPassword);
      message.success(t("settings.passwordChanged"));
    } catch (e: any) {
      message.error(e?.response?.data?.error || t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Typography.Title level={4} className="page-title">
        {t("nav.settings")}
      </Typography.Title>

      <SettingsCard title={t("settings.account")} style={{ marginBottom: 16 }}>
        <Typography.Text>{t("settings.currentUser")}</Typography.Text>
        <Typography.Text strong>{user?.username}</Typography.Text>
      </SettingsCard>

      <SettingsCard
        title={t("pref.retention")}
        subtitle={t("pref.retentionHint")}
        style={{ marginBottom: 16 }}
      >
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
              {t("pref.retentionMode")}
            </Typography.Text>
            <Select<AudioRetentionMode>
              value={prefs?.audioRetentionMode}
              loading={!prefs}
              style={{ width: 200 }}
              onChange={(value) => void savePrefs({ audioRetentionMode: value })}
              options={[
                { value: "unused", label: t("pref.retentionModeUnused") },
                { value: "all", label: t("pref.retentionModeAll") },
              ]}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
              {t("pref.retention")}
            </Typography.Text>
            <Select<number>
              value={prefs?.audioRetentionDays}
              loading={!prefs}
              style={{ width: 200 }}
              onChange={(value) => void savePrefs({ audioRetentionDays: value })}
              options={RETENTION_DAYS.map((days) => ({ value: days, label: retentionLabel(days) }))}
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title={t("settings.password")}>
        <Form layout="vertical" onFinish={onSave}>
          <Form.Item name="oldPassword" label={t("settings.oldPassword")} rules={[{ required: true, message: t("settings.oldRequired") }]}>
            <Input.Password variant="outlined" />
          </Form.Item>
          <Form.Item name="newPassword" label={t("settings.newPassword")} rules={[
            { required: true, message: t("settings.newRequired") },
            { min: 6, message: t("settings.min6") },
          ]}>
            <Input.Password variant="outlined" />
          </Form.Item>
          <Form.Item name="confirm" label={t("settings.confirmPassword")} dependencies={["newPassword"]} rules={[
            { required: true, message: t("settings.confirmRequired") },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue("newPassword") === value) return Promise.resolve();
                return Promise.reject(new Error(t("settings.mismatch")));
              },
            }),
          ]}>
            <Input.Password variant="outlined" />
          </Form.Item>
          <Button
            color="primary"
            variant="outlined"
            htmlType="submit"
            loading={saving}
            style={{ color: primaryText, borderColor: primaryText }}
          >
            {t("act.save")}
          </Button>
        </Form>
      </SettingsCard>
    </div>
  );
}
