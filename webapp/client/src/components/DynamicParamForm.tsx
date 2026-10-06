import type { ReactNode } from "react";
import { Button, Form, Input, InputNumber, Segmented, Select, Space, Switch, theme } from "antd";
import type { ParamField, Voice } from "../api/client";
import { useI18n } from "../i18n";
import { groupOf, isHiddenParam, optionLabelKey, PARAM_OPTION_FLAGS, type ParamGroupKey } from "./paramGroups";
import { SettingRow, inputCh, longestOption, selectWidth } from "./settings/SettingRow";

interface Props {
  fields: Record<string, ParamField>;
  voices?: Voice[];
  /** 只渲染该页签的参数；省略时渲染全部。 */
  group?: ParamGroupKey;
}

/** 情感向量的 8 个维度（顺序与 IndexTTS 一致），文案按当前语种解析。 */
const EMO_KEYS = [
  "emo.happy", "emo.angry", "emo.sad", "emo.fear",
  "emo.disgust", "emo.melancholy", "emo.surprise", "emo.calm",
] as const;
const SEED_RANDOM = -1;

/** 随机种子：可选“随机”或填写固定整数（默认 1234）。 */
function SeedField({ value, onChange }: { value?: unknown; onChange?: (v: number) => void }) {
  const { t } = useI18n();
  const random = value === SEED_RANDOM || value === "random";
  const fixed = typeof value === "number" && value >= 0 ? value : 1234;
  return (
    <Space wrap size={8}>
      <Segmented
        value={random ? "random" : "fixed"}
        onChange={(mode) => onChange?.(mode === "random" ? SEED_RANDOM : fixed)}
        options={[
          { label: t("param.random"), value: "random" },
          { label: t("param.fixed"), value: "fixed" },
        ]}
      />
      <InputNumber
        className="st-input-num"
        min={0}
        step={1}
        precision={0}
        disabled={random}
        value={fixed}
        onChange={(v) => onChange?.(typeof v === "number" ? v : 1234)}
        placeholder="1234"
      />
    </Space>
  );
}

/** 8 维情感向量 [高兴, 愤怒, 悲伤, 害怕, 厌恶, 忧郁, 惊讶, 平静]，一排滚轮，步长 0.1。 */
function EmotionVectorField({ value, onChange }: { value?: unknown; onChange?: (v: number[]) => void }) {
  const { t } = useI18n();
  const vec =
    Array.isArray(value) && value.length === EMO_KEYS.length
      ? (value as number[])
      : EMO_KEYS.map(() => 0);
  const setAt = (index: number, n: number | null) => {
    const next = [...vec];
    next[index] = typeof n === "number" ? n : 0;
    onChange?.(next);
  };
  const { token } = theme.useToken();
  return (
    <Space wrap size={6}>
      {EMO_KEYS.map((key, i) => (
        <span
          key={key}
          style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }}
        >
          <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{t(key)}</span>
          <InputNumber
            className="st-input-num"
            size="small"
            min={0}
            max={1}
            step={0.1}
            precision={1}
            value={vec[i]}
            onChange={(n) => setAt(i, n)}
          />
        </span>
      ))}
    </Space>
  );
}

/** 开关式状态按钮：显示当前状态（启用/禁用），点击切换。 */
function EnableToggle({ value, onChange }: { value?: unknown; onChange?: (v: boolean) => void }) {
  const { t } = useI18n();
  const enabled = Boolean(value);
  return (
    <Button size="small" type={enabled ? "primary" : "default"} onClick={() => onChange?.(!enabled)}>
      {enabled ? t("param.enabled") : t("param.disabled")}
    </Button>
  );
}

/** 条件匹配：支持 `field`（truthy）与 `field=value`（等值）两种写法。 */
function matches(cond: string, values?: Record<string, unknown>): boolean {
  const match = /^([^=]+)=(.*)$/.exec(cond);
  if (match) return String(values?.[match[1].trim()]) === match[2].trim();
  return Boolean(values?.[cond]);
}

/** 字段可见性：`show_when` 不成立时隐藏。 */
function isVisible(f: ParamField, values?: Record<string, unknown>): boolean {
  if (!f.show_when) return true;
  return matches(f.show_when, values);
}

/** 字段禁用：`enabled_when` 不成立时灰化（但仍显示）。 */
function isDisabled(f: ParamField, values?: Record<string, unknown>): boolean {
  if (!f.enabled_when) return false;
  return !matches(f.enabled_when, values);
}

function segmentedOptions(options: unknown[] = []) {
  return options.map((o) => {
    if (o && typeof o === "object") {
      const opt = o as { label?: unknown; value?: unknown };
      return { label: String(opt.label ?? opt.value ?? ""), value: String(opt.value ?? "") };
    }
    return { label: String(o), value: String(o) };
  });
}

/** 单个参数字段 → 一行（标签列 + 控件列）。 */
function ParamItem({
  name,
  field,
  voices,
  disabled,
}: {
  name: string;
  field: ParamField;
  voices: Voice[];
  disabled: boolean;
}) {
  const { t } = useI18n();
  const label = field.title ?? name;
  const required = field.required === true;
  /** 无标签（title 为空）时不再生成「请输入 」这类占位文案。 */
  const inputPlaceholder = field.placeholder || (label ? t("param.pleaseInput", { label }) : "");
  const common = {
    name,
    rules: required ? [{ required: true, message: t("param.pleaseFill", { label }) }] : undefined,
    valuePropName: field.type === "boolean" ? "checked" : "value",
    extra: field.help ? <span>{field.help}</span> : undefined,
  };

  let control: ReactNode;
  if (field.type === "toggle") {
    control = <EnableToggle />;
  } else if (field.type === "boolean") {
    control = <Switch disabled={disabled} />;
  } else if (field.type === "segmented") {
    control = <Segmented disabled={disabled} options={segmentedOptions(field.options)} />;
  } else if (field.type === "select") {
    const options = field.options || [];
    // 显示文案可用 PARAM_OPTION_KEYS 覆盖（如语言显示国旗 + 语言名），value 不变。
    const flags = PARAM_OPTION_FLAGS[name];
    const display = options.map((o) => {
      const labelKey = optionLabelKey(name, String(o));
      return labelKey ? t(labelKey) : String(o);
    });
    control = (
      <Select
        disabled={disabled}
        style={{ width: selectWidth(display) }}
        data-longest-option={longestOption(display)}
        options={options.map((o, index) => {
          const flag = flags?.[String(o)];
          return {
            value: String(o),
            label: flag ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <img
                  src={`/country_flag/${flag}`}
                  width={24}
                  height={24}
                  alt=""
                  style={{ borderRadius: "50%", flex: "0 0 auto" }}
                />
                {display[index]}
              </span>
            ) : (
              display[index]
            ),
          };
        })}
        placeholder={label ? t("param.pleaseSelect", { label }) : undefined}
      />
    );
  } else if (field.type === "audioRef") {
    const options = voices.map((v) => `${v.name} (${v.file_name})`);
    control = (
      <Select
        disabled={disabled}
        style={{ width: selectWidth(options) }}
        data-longest-option={longestOption(options)}
        placeholder={t("param.selectVoice")}
        allowClear={!required}
        options={voices.map((v) => ({ label: `${v.name} (${v.file_name})`, value: v.id }))}
      />
    );
  } else if (field.type === "seed") {
    control = <SeedField />;
  } else if (field.type === "emotionVector") {
    control = <EmotionVectorField />;
  } else if (field.type === "number" || field.type === "integer") {
    control = (
      <InputNumber
        className="st-input-num"
        disabled={disabled}
        min={field.min}
        max={field.max}
        step={field.step ?? (field.type === "integer" ? 1 : 0.1)}
        precision={field.type === "integer" ? 0 : undefined}
          placeholder={inputPlaceholder}
      />
    );
  } else if (field.type === "text") {
    control = (
      <Input.TextArea
        className="st-input"
        style={{ width: `${inputCh(name)}ch` }}
        disabled={disabled}
        rows={field.rows ?? 3}
          placeholder={inputPlaceholder}
      />
    );
  } else {
    control = (
      <Input
        className="st-input"
        style={{ width: `${inputCh(name)}ch` }}
        disabled={disabled}
          placeholder={inputPlaceholder}
      />
    );
  }

  return (
    <SettingRow label={label} required={required}>
      <Form.Item {...common}>{control}</Form.Item>
    </SettingRow>
  );
}

/**
 * 渲染某页签的动态参数行（标签列 + 控件列）。
 * 必须放在 `.st-grid` 内，标签/控件才会参与同一套两列 Grid。
 */
export default function DynamicParamForm({ fields, voices = [], group }: Props) {
  const form = Form.useFormInstance();
  const values = Form.useWatch([], form) as Record<string, unknown> | undefined;
  const entries = Object.entries(fields).filter(
    ([key, f]) =>
      !isHiddenParam(key) && (group ? groupOf(key) === group : true) && isVisible(f, values)
  );

  return (
    <>
      {entries.map(([key, f]) => (
        <ParamItem key={key} name={key} field={f} voices={voices} disabled={isDisabled(f, values)} />
      ))}
    </>
  );
}
