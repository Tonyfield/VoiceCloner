import { useCallback, useEffect, useState } from "react";
import {
  Button, Card, Form, Input, List, Modal, Popconfirm, Space, Tag, Typography, message,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { deleteModel, getModels, saveModel, type ModelSpec } from "../api/client";
import { useI18n } from "../i18n";

export default function ModelsPage() {
  const { t } = useI18n();
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ModelSpec | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => setModels(await getModels()), []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      api_path: "/v1/audio/speech",
      parameters_schema_yaml: DEFAULT_SCHEMA,
    });
    setFormOpen(true);
  };
  const openEdit = (m: ModelSpec) => {
    setEditing(m);
    form.setFieldsValue({
      name: m.name,
      api_url: m.api_url,
      api_path: m.api_path,
      api_key: m.api_key,
      parameters_schema_yaml: m.parameters_schema_yaml,
    });
    setFormOpen(true);
  };

  const onSave = async (values: any) => {
    setSaving(true);
    try {
      await saveModel(values, editing?.id);
      message.success(t("model.saved"));
      setFormOpen(false);
      await refresh();
    } catch (e: any) {
      message.error(e?.response?.data?.error || t("model.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: number) => {
    await deleteModel(id);
    message.success(t("model.deleted"));
    await refresh();
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Typography.Title level={4} className="page-title" style={{ margin: 0 }}>
          {t("nav.models")}
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t("act.add")}
        </Button>
      </div>

      <List
        grid={{ gutter: 16, column: 1 }}
        dataSource={models}
        renderItem={(m) => (
          <List.Item>
            <Card className="flat-card" style={{ borderRadius: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <Space>
                    <Typography.Text strong>{m.name}</Typography.Text>
                    <Tag>{m.api_path}</Tag>
                  </Space>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {m.api_url}
                    </Typography.Text>
                  </div>
                </div>
                <Space>
                  <Popconfirm title={t("model.confirmDelete")} onConfirm={() => onDelete(m.id)} okText={t("act.delete")} okButtonProps={{ danger: true }}>
                    <Button icon={<DeleteOutlined />} danger />
                  </Popconfirm>
                  <Button icon={<EditOutlined />} onClick={() => openEdit(m)} />
                </Space>
              </div>
            </Card>
          </List.Item>
        )}
      />

      <Modal
        title={editing ? t("model.editTitle") : t("model.addTitle")}
        open={formOpen}
        onCancel={() => setFormOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        width={720}
        okText={t("act.save")}
      >
        <Form form={form} layout="vertical" onFinish={onSave}>
          <Form.Item name="name" label={t("model.name")} rules={[{ required: true, message: t("model.nameRequired") }]}>
            <Input placeholder={t("model.namePlaceholder")} />
          </Form.Item>
          <Form.Item name="api_url" label="API URL" rules={[{ required: true, message: t("model.apiUrlRequired") }]}>
            <Input placeholder={t("model.apiUrlPlaceholder")} />
          </Form.Item>
          <Form.Item name="api_path" label="API Path">
            <Input placeholder="/v1/audio/speech" />
          </Form.Item>
          <Form.Item name="api_key" label="API Key">
            <Input placeholder={t("model.apiKeyPlaceholder")} />
          </Form.Item>
          <Form.Item
            name="parameters_schema_yaml"
            label="Parameters Schema（YAML）"
            extra={
              <div style={{ fontSize: 12 }}>{t("model.schemaHelp")}</div>
            }
          >
            <Input.TextArea rows={12} style={{ fontFamily: "monospace" }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

const DEFAULT_SCHEMA = `label: IndexTTS v2.5
params:
  model:
    title: 模型名
    type: string
    default: IndexTeam/IndexTTS-2.5
    required: true
  voice:
    title: 音色
    type: string
    default: default
  use_instructions:
    title: 启用合成指令
    type: boolean
    default: false
  instructions:
    title: 合成指令
    type: text
    default: |
      文学朗读风格。吐字清晰，声音厚实温和，节奏从容。
      旁白客观而有感染力，人物对白采用轻度角色化演绎。
      停顿自然，富有叙事张力。
    show_when: use_instructions
  language:
    title: 语言
    type: select
    options: [zh, en, ja]
    default: zh
    help: 指定语种
  task_type:
    title: 任务类型
    type: select
    options: [CustomVoice, VoiceDesign, Base]
    default: CustomVoice
  stream_format:
    title: 流式格式
    type: string
    default: sse
  stream:
    title: 流式响应
    type: boolean
    default: false
  duration_seconds:
    title: 目标时长（秒）
    type: number
    default: 0
  x_vector_only_mode:
    title: 仅使用音色向量
    type: boolean
    default: false
  speed:
    title: 语速
    type: number
    default: 1.0
  max_new_tokens:
    title: 最大 tokens
    type: integer
    default: 1000
  seed:
    title: 随机种子
    type: seed
    default: 1234
    help: 可选“随机”（每次合成随机）或固定整数（默认 1234）
  initial_codec_chunk_frames:
    title: 首个 codec 分块帧数
    type: integer
    default: 0
  non_streaming_mode:
    title: 非流式模式
    type: boolean
    default: false
  response_format:
    title: 输出格式
    type: select
    options: [wav, mp3, flac, pcm]
    default: wav
  ref_audio:
    title: 参考音频路径或 URL
    type: string
    default: null
  emotion_mode:
    title: 情感来源
    type: segmented
    options:
      - { label: 关闭, value: none }
      - { label: 文本, value: text }
      - { label: 随机, value: random }
      - { label: 情感向量, value: vector }
    default: none
    help: 三种情感方式互斥，也可全部关闭
  emo_alpha:
    title: 情感权重（emo_alpha）
    type: number
    default: 0.3
    min: 0
    max: 1
    step: 0.05
    help: 情感参考音频权重，范围 0.0-1.0
  emo_text:
    title: 情感描述（emo_text）
    type: text
    default: ""
    show_when: emotion_mode=text
    help: 留空时按正文自动生成情感（use_emo_text）；填写后实现文本与情感分离
  emo_vector:
    title: 情感向量
    type: emotionVector
    default: [0, 0, 0, 0, 0, 0, 0, 0]
    show_when: emotion_mode=vector
    help: 每个维度 0.0-1.0，步长 0.1
`;