import { useCallback, useEffect, useState } from "react";
import {
  Button, Card, Form, Input, List, Modal, Popconfirm, Typography, Upload, message,
} from "antd";
import { DeleteOutlined, PlusOutlined, UploadOutlined } from "@ant-design/icons";
import { deleteVoice, getVoices, uploadVoice, type Voice } from "../api/client";
import { useI18n } from "../i18n";

const MAX_MB = 5;

export default function VoicesPage() {
  const { t } = useI18n();
  const [voices, setVoices] = useState<Voice[]>([]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [file, setFile] = useState<File | undefined>();
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => setVoices(await getVoices()), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const onUpload = async (values: any) => {
    if (!file) {
      message.error(t("voice.selectRequired"));
      return;
    }
    setSaving(true);
    try {
      await uploadVoice(values.name || file.name, file);
      message.success(t("voice.uploaded"));
      setOpen(false);
      setFile(undefined);
      await refresh();
    } catch (e: any) {
      message.error(e?.response?.data?.error || t("voice.uploadFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Typography.Title level={4} className="page-title" style={{ margin: 0 }}>
          {t("nav.voices")}
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          {t("voice.upload")}
        </Button>
      </div>

      <List
        grid={{ gutter: 16, column: 3 }}
        dataSource={voices}
        renderItem={(v) => (
          <List.Item>
            <Card className="flat-card" style={{ borderRadius: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <Typography.Text strong>{v.name}</Typography.Text>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {v.file_name} · {(v.size / 1024).toFixed(1)} KB
                    </Typography.Text>
                  </div>
                  <audio controls src={`/api/voices/${v.id}/audio`} style={{ width: 220, marginTop: 6 }} />
                </div>
                <Popconfirm title={t("voice.confirmDelete")} onConfirm={async () => { await deleteVoice(v.id); await refresh(); }} okText={t("act.delete")} okButtonProps={{ danger: true }}>
                  <Button icon={<DeleteOutlined />} danger />
                </Popconfirm>
              </div>
            </Card>
          </List.Item>
        )}
      />

      <Modal title={t("voice.upload")} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} confirmLoading={saving} okText={t("act.upload")}>
        <Form form={form} layout="vertical" onFinish={onUpload}>
          <Form.Item label={t("voice.audioLabel")} required>
            <Upload
              beforeUpload={(f) => {
                if (f.size > MAX_MB * 1024 * 1024) {
                  message.error(t("voice.tooLarge", { size: MAX_MB }));
                  return Upload.LIST_IGNORE;
                }
                setFile(f);
                return false;
              }}
              maxCount={1}
              onRemove={() => setFile(undefined)}
              fileList={file ? [{ uid: "0", name: file.name }] : []}
              accept="audio/*"
            >
              <Button icon={<UploadOutlined />}>{t("voice.choose")}</Button>
            </Upload>
          </Form.Item>
          <Form.Item name="name" label={t("voice.name")} extra={t("voice.nameExtra")}>
            <Input placeholder={file?.name || t("voice.namePlaceholder")} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}