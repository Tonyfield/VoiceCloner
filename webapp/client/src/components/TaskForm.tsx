import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button, Checkbox, Form, Input, Modal, Select, Space, Switch, Tooltip, Typography, Upload, message,
} from "antd";
import { UploadOutlined } from "@ant-design/icons";
import type { ModelSpec, Task, Voice, ParamField } from "../api/client";
import DynamicParamForm from "./DynamicParamForm";
import { PARAM_GROUPS, PARAM_HELP_KEYS, PARAM_OPTION_KEYS, PARAM_OPTION_VALUES, PARAM_TITLE_KEYS } from "./paramGroups";
import SettingsShell from "./settings/SettingsShell";
import { SettingRow, selectWidth } from "./settings/SettingRow";
import NamedEntityTable from "./NamedEntityTable";
import ReplaceRulesModal, { type TextRule } from "./ReplaceRulesModal";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n/locales";

/** 特殊选项：跳转到声音设置页新增声音样本 */
const ADD_VOICE_VALUE = "__ADD_VOICE__";

interface Props {
  open: boolean;
  models: ModelSpec[];
  voices: Voice[];
  task?: Task | null;
  onCancel: () => void;
  onSubmit: (values: any, file?: File, overwrite?: boolean) => Promise<void>;
}

function defaultsFor(fields: Record<string, ParamField>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(fields)) {
    if (f.default !== undefined && f.default !== null) {
      out[k] = typeof f.default === "object" ? JSON.parse(JSON.stringify(f.default)) : f.default;
      continue;
    }
    // 没有默认值的下拉/分段控件默认选中第一个选项
    if ((f.type === "select" || f.type === "segmented") && f.options?.length) {
      out[k] = f.options[0];
    }
  }
  return out;
}

/** 分段文本增强相关的任务级默认值（与后端 textEnhance.enhanceOptionsFromParams 对应）。 */
const TEXT_ENHANCE_DEFAULTS = {
  word_gap_enabled: false,
  word_gap: "-",
  text_rules: [],
};

/** 分段长度是任务级参数，并入「文档」页签展示（标题/说明按当前语种解析）。 */
const SEGMENT_MAX_CHARS_FIELD: ParamField = {
  type: "integer",
  default: 100,
  min: 10,
  max: 1000,
  step: 10,
};

/** 参数展示顺序（同一页签内按此顺序排布）。 */
const FIELD_ORDER = [
  "segment_max_chars", "language",
  "task_type",
  "response_format", "duration_seconds",
  "voice", "speed", "seed",
  "stream", "non_streaming_mode", "max_new_tokens",
  "use_instructions", "instructions",
  "emotion_mode", "emo_alpha", "emo_text", "emo_vector",
  "initial_codec_chunk_frames", "stream_format",
];

export default function TaskForm({
  open, models, voices, task, onCancel, onSubmit,
}: Props) {
  const { t } = useI18n();
  const [form] = Form.useForm();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | undefined>();
  const [overwritePrompt, setOverwritePrompt] = useState(false);
  const pending = useRef<{ values: any; file?: File }>({ values: null });
  const [modelId, setModelId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("input");
  const [namedEntityOpen, setNamedEntityOpen] = useState(false);
  const [namedEntityCount, setNamedEntityCount] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false);
  /** 打开时的初始值，用于「重置」。 */
  const baseline = useRef<Record<string, unknown>>({});

  const selected = models.find((m) => m.id === modelId);
  const fields = useMemo(() => {
    const schema: Record<string, ParamField> = {
      segment_max_chars: {
        ...SEGMENT_MAX_CHARS_FIELD,
        title: t("task.maxChars"),
        help: t("task.maxCharsHelp"),
      },
      ...(selected?.schema?.params || {}),
    };
    // 启用/禁用状态按钮：不显示左侧 label（title 置空）
    if (schema.use_instructions) {
      schema.use_instructions = { ...schema.use_instructions, type: "toggle", title: "" };
    }
    // 指令文本框：始终显示，禁用时灰化但不隐藏；不显示标签
    if (schema.instructions) {
      schema.instructions = {
        ...schema.instructions,
        title: "",
        rows: 14,
        show_when: undefined,
        enabled_when: "use_instructions",
      };
    }
    // 统一文案/选项覆盖（集中在 paramGroups，按当前语种解析）
    for (const [key, field] of Object.entries(schema)) {
      const titleKey = PARAM_TITLE_KEYS[key];
      const helpKey = PARAM_HELP_KEYS[key];
      const optionKeys = PARAM_OPTION_KEYS[key];
      const forcedValues = PARAM_OPTION_VALUES[key];
      if (!titleKey && !helpKey && !optionKeys && !forcedValues) continue;
      let next: ParamField = field;
      if (titleKey) next = { ...next, title: t(titleKey) };
      if (helpKey) next = { ...next, help: t(helpKey) };
      if (forcedValues) {
        // 追加缺失的可选值，保留模型 schema 自带的选项与顺序（不覆盖）。
        const existing = new Set(
          (next.options ?? []).map((option) =>
            typeof option === "object" && option
              ? String((option as { value?: unknown }).value)
              : String(option)
          )
        );
        const added = forcedValues.filter((value) => !existing.has(value));
        next = { ...next, options: [...(next.options ?? []), ...added] };
      }
      if (optionKeys && next.options?.length) {
        next = {
          ...next,
          options: next.options.map((option) => {
            if (typeof option === "object" && option) {
              const opt = option as { value?: unknown; label?: unknown };
              const labelKey = optionKeys[String(opt.value)];
              return labelKey ? { ...opt, label: t(labelKey) } : option;
            }
            return option;
          }),
        };
      }
      schema[key] = next;
    }
    const ordered: Record<string, ParamField> = {};
    for (const key of [...FIELD_ORDER, ...Object.keys(schema)]) {
      const f = schema[key];
      if (!f || ordered[key]) continue;
      ordered[key] = f;
    }
    return ordered;
  }, [selected, t]);

  /** 当前文档名：优先显示新选择的文件，其次显示任务已上传的文档。 */
  const docName = file?.name ?? task?.upload_name ?? undefined;
  const wordGapEnabled = Form.useWatch("word_gap_enabled", form);
  // text_rules 由弹窗管理、非注册字段，useWatch 不生效，用本地 state 维护规则数用于展示。
  const [ruleCount, setRuleCount] = useState(0);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setFile(undefined);
    setOverwritePrompt(false);
    setActiveTab("input");
    pending.current = { values: null };

    if (task) {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(task.params_json || "{}"); } catch { /* ignore */ }
      const modelIdNum = task.model_id || undefined;
      setModelId(modelIdNum ?? null);
      const m = models.find((x) => x.id === modelIdNum);
      const merged = {
        phonetic: false,
        ...TEXT_ENHANCE_DEFAULTS,
        ...defaultsFor({ segment_max_chars: SEGMENT_MAX_CHARS_FIELD, ...(m?.schema?.params || {}) }),
        ...params,
        phonetic_format: params.phonetic_format || "cedict",
      };
      const values = { name: task.name, model_id: modelIdNum, skip_tts: Boolean(task.skip_tts), ...merged };
      baseline.current = values;
      form.setFieldsValue(values);
      setRuleCount(Array.isArray(values.text_rules) ? values.text_rules.length : 0);
    } else {
      setModelId(null);
      const values = {
        skip_tts: false,
        phonetic: false,
        phonetic_format: "cedict",
        segment_max_chars: SEGMENT_MAX_CHARS_FIELD.default,
        ...TEXT_ENHANCE_DEFAULTS,
      };
      baseline.current = values;
      form.setFieldsValue(values);
      setRuleCount(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task]);

  const onModelChange = (v: number | null) => {
    setModelId(v);
    const m = models.find((x) => x.id === v);
    const defaults = defaultsFor({ segment_max_chars: SEGMENT_MAX_CHARS_FIELD, ...(m?.schema?.params || {}) });
    for (const key of Object.keys(defaults)) form.setFieldValue(key, defaults[key]);
  };

  const submit = async (values: any, forceOverwrite?: boolean) => {
    setSaving(true);
    try {
      await onSubmit(values, file, forceOverwrite);
      setOverwritePrompt(false);
    } catch (e: any) {
      if (e?.response?.status === 409) {
        pending.current = { values };
        setOverwritePrompt(true);
      } else {
        message.error(e?.response?.data?.error || t("task.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const onFinish = (values: any) => {
    // text_rules 由弹窗管理（非注册字段），显式取回，避免未随表单提交。
    submit({ ...values, model_id: modelId, text_rules: form.getFieldValue("text_rules") ?? [] });
  };

  const resetForm = () => {
    form.resetFields();
    form.setFieldsValue(baseline.current);
    setRuleCount(Array.isArray(baseline.current.text_rules) ? (baseline.current.text_rules as unknown[]).length : 0);
    setFile(undefined);
  };

  const nameItem = (
    <Form.Item
      name="name"
      label={t("task.name")}
      labelCol={{ flex: "0 0 auto" }}
      wrapperCol={{ flex: "0 0 auto" }}
      rules={[{ required: true, message: t("task.nameRequired") }]}
    >
      <Input className="st-input" style={{ width: "28ch" }} placeholder={t("task.namePlaceholder")} />
    </Form.Item>
  );

  const modelItem = (
    <Form.Item
      name="model_id"
      label={t("task.model")}
      labelCol={{ flex: "0 0 auto" }}
      wrapperCol={{ flex: "0 0 auto" }}
      rules={[{ required: true, message: t("task.modelRequired") }]}
    >
      <Select
        showSearch
        placeholder={t("task.modelPlaceholder")}
        optionFilterProp="label"
        onChange={onModelChange}
        style={{ width: selectWidth(models.map((m) => m.name)) }}
        options={models.map((m) => ({ label: m.name, value: m.id }))}
      />
    </Form.Item>
  );

  const skipRow = (
    <SettingRow label={t("task.segmentOnly")}>
      <Form.Item name="skip_tts" valuePropName="checked">
        <Switch />
      </Form.Item>
    </SettingRow>
  );

  const docRow = (
    <SettingRow label={t("task.document")} required={!task}>
      <Space align="center" wrap size={8}>
        <Upload
          beforeUpload={(f) => {
            setFile(f);
            if (!task && !form.getFieldValue("name")) form.setFieldValue("name", f.name);
            return false;
          }}
          maxCount={1}
          showUploadList={false}
          fileList={file ? [{ uid: "0", name: file.name }] : []}
          onRemove={() => setFile(undefined)}
        >
          <Tooltip title={docName ? t("task.replaceDoc") : t("task.selectDoc")}>
            <Button icon={<UploadOutlined />} />
          </Tooltip>
        </Upload>
        {docName ? (
          <Typography.Text className="st-ellipsis" style={{ maxWidth: 320 }} title={docName}>
            {docName}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">{t("task.noDocSelected")}</Typography.Text>
        )}
        {file && (
          <Button type="link" size="small" onClick={() => setFile(undefined)}>
            {t("act.remove")}
          </Button>
        )}
      </Space>
    </SettingRow>
  );

  const voiceRow = (
    <SettingRow label={t("task.voice")}>
      <Form.Item name="voice_file_id">
        <Select
          placeholder={t("task.voicePlaceholder")}
          allowClear
          style={{ width: selectWidth(voices.map((v) => `${v.name} (${v.file_name})`)) }}
          onChange={(v: any) => {
            if (v === ADD_VOICE_VALUE) {
              form.setFieldValue("voice_file_id", undefined);
              navigate("/voices");
            }
          }}
          options={[
            ...voices.map((v) => ({ label: `${v.name} (${v.file_name})`, value: v.id })),
            { label: t("task.addVoice"), value: ADD_VOICE_VALUE },
          ]}
        />
      </Form.Item>
    </SettingRow>
  );

  const phoneticRow = (
    <SettingRow label={t("task.autoPhonetic")}>
      <div className="st-inline">
        <Form.Item name="phonetic" valuePropName="checked" noStyle>
          <Switch />
        </Form.Item>
        <span style={{ color: "var(--st-text-2)", fontSize: 12 }}>{t("task.phoneticFormat")}</span>
        <Form.Item name="phonetic_format" noStyle>
          <Select disabled style={{ width: 110 }} options={[{ label: "cedict", value: "cedict" }]} />
        </Form.Item>
      </div>
    </SettingRow>
  );

  const wordGapRow = (
    <SettingRow label="">
      <div className="st-inline">
        <Form.Item name="word_gap_enabled" valuePropName="checked" noStyle>
          <Checkbox>{t("task.insertBetween")}</Checkbox>
        </Form.Item>
        <Form.Item name="word_gap" noStyle>
          <Input
            style={{ width: "10ch" }}
            maxLength={8}
            disabled={!wordGapEnabled}
            placeholder="-"
          />
        </Form.Item>
      </div>
    </SettingRow>
  );

  // 替换规则改为弹窗管理（增 / 删 / 改），表单只保存最终规则数组。
  const rulesRow = (
    <SettingRow label={t("task.replaceRules")}>
      <Space align="center" wrap size={8}>
        <Button size="small" onClick={() => setRulesOpen(true)}>
          {t("task.manageRules")}
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {ruleCount > 0 ? t("task.rulesCount", { count: ruleCount }) : t("task.ruleEmpty")}
        </Typography.Text>
      </Space>
    </SettingRow>
  );

  const namedEntityRow = (
    <SettingRow label={t("task.namedEntities")}>
      <Space align="center" wrap size={8}>
        <Button size="small" onClick={() => setNamedEntityOpen(true)}>
          {t("task.manageEntities")}
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {namedEntityCount > 0
            ? t("task.namedEntityCount", { count: namedEntityCount })
            : t("task.namedEntityHint")}
        </Typography.Text>
      </Space>
    </SettingRow>
  );

  const renderPanel = (key: string) => {
    if (key === "input") {
      return (
        <>
          {skipRow}
          {docRow}
          {voiceRow}
          <DynamicParamForm fields={fields} voices={voices} group="input" />
        </>
      );
    }
    if (key === "segment") {
      return <DynamicParamForm fields={fields} voices={voices} group="segment" />;
    }
    if (key === "phonetic") {
      return (
        <>
          <DynamicParamForm fields={fields} voices={voices} group="phonetic" />
          {phoneticRow}
          {wordGapRow}
          {rulesRow}
          {namedEntityRow}
        </>
      );
    }
    const group = PARAM_GROUPS.find((g) => g.key === key);
    if (!group) return null;
    return <DynamicParamForm fields={fields} voices={voices} group={group.key} />;
  };

  return (
    <>
      <Modal
        title={task ? t("dlg.editTask") : t("dlg.newTask")}
        open={open}
        onCancel={onCancel}
        footer={null}
        width={1040}
        centered
        destroyOnClose
        styles={{ body: { padding: 0, overflow: "hidden" } }}
      >
        <Form
          form={form}
          className="task-form"
          layout="horizontal"
          onFinish={onFinish}
        >
          <div className="st-page">
            <div className="st-page-head">
              {nameItem}
              {modelItem}
              <div className="st-page-actions">
                <Button size="small" onClick={resetForm}>
                  {t("act.reset")}
                </Button>
                <Button size="small" type="primary" loading={saving} onClick={() => form.submit()}>
                  {t("act.save")}
                </Button>
              </div>
            </div>
            <div className="st-page-divider" />
            {modelId != null ? (
              <SettingsShell
                tabs={PARAM_GROUPS.map((g) => ({
                  key: g.key,
                  label: t(`tab.${g.key}` as keyof Messages),
                }))}
                active={activeTab}
                onChange={setActiveTab}
              >
                {(key) => <div className="st-grid">{renderPanel(key)}</div>}
              </SettingsShell>
            ) : (
              <div className="st-page-empty">{t("task.selectModelFirst")}</div>
            )}
          </div>
        </Form>
      </Modal>

      <NamedEntityTable
        open={namedEntityOpen}
        onClose={() => setNamedEntityOpen(false)}
        onCountChange={setNamedEntityCount}
      />

      <ReplaceRulesModal
        open={rulesOpen}
        value={(form.getFieldValue("text_rules") as TextRule[]) ?? []}
        onCancel={() => setRulesOpen(false)}
        onOk={(rules) => {
          form.setFieldValue("text_rules", rules);
          setRuleCount(rules.length);
          setRulesOpen(false);
        }}
      />

      <Modal
        open={overwritePrompt}
        title={t("task.exists")}
        onCancel={() => setOverwritePrompt(false)}
        okText={t("task.overwrite")}
        okButtonProps={{ danger: true }}
        onOk={() => {
          submit(pending.current.values, true);
        }}
      >
        <p>{t("task.existsDesc")}</p>
      </Modal>
    </>
  );
}
