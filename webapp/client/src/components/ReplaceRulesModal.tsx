import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Select, Space, Switch, Tooltip, Typography, message } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useI18n } from "../i18n";
import { MANAGED_MODAL_BODY_HEIGHT } from "./modalSizes";

/** 规则处理方式：替换匹配文本 / 在匹配前插入 / 在匹配后插入。 */
export type RuleAction = "replace" | "before" | "after";

/** 单条替换规则（任务参数 text_rules 的规范形态）。 */
export interface TextRule {
  /** 匹配内容：regex 为 true 时是正则，否则是字面量。 */
  pattern: string;
  action: RuleAction;
  /** 替换内容 / 插入内容（支持换行）。 */
  insert: string;
  /** 是否按正则解释 pattern。 */
  regex: boolean;
}

interface EditorRow extends TextRule {
  key: number;
}

/** 把任务里可能存在的历史规则（position 字段、无 regex）规范化为编辑行。 */
function normalizeRules(value: unknown): TextRule[] {
  if (!Array.isArray(value)) return [];
  const out: TextRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const pattern = typeof rec.pattern === "string" ? rec.pattern : "";
    if (!pattern) continue;
    const insert = typeof rec.insert === "string" ? rec.insert : "";
    const rawAction = rec.action ?? rec.position;
    const action: RuleAction =
      rawAction === "replace" || rawAction === "before" || rawAction === "after" ? rawAction : "after";
    // 历史规则均为正则；新规则由用户显式选择，默认关闭。
    const regex = typeof rec.regex === "boolean" ? rec.regex : true;
    out.push({ pattern, action, insert, regex });
  }
  return out;
}

/**
 * 替换规则管理弹窗：列出规则并支持增 / 删 / 改。
 * 每行：匹配内容、处理方式（替换为 / 前插入 / 后插入）、替换/插入内容、正则开关。
 */
export default function ReplaceRulesModal({
  open,
  value,
  onCancel,
  onOk,
}: {
  open: boolean;
  value: TextRule[];
  onCancel: () => void;
  onOk: (rules: TextRule[]) => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<EditorRow[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setRows(normalizeRules(value).map((rule) => ({ key: seq.current++, ...rule })));
    // 仅在打开时按外部值初始化；编辑过程由本地 rows 维护。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const actionOptions = [
    { value: "replace" as const, label: t("task.ruleActionReplace") },
    { value: "before" as const, label: t("task.ruleBefore") },
    { value: "after" as const, label: t("task.ruleAfter") },
  ];

  const addRow = () => {
    // 需求：默认处理方式为「替换为」，正则默认关闭。
    setRows((prev) => [...prev, { key: seq.current++, pattern: "", action: "replace", insert: "", regex: false }]);
  };
  const removeRow = (key: number) => setRows((prev) => prev.filter((row) => row.key !== key));
  const patchRow = (key: number, patch: Partial<TextRule>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const handleOk = () => {
    for (const row of rows) {
      if (!row.pattern || !row.insert) {
        message.warning(t("task.ruleIncomplete"));
        return;
      }
      if (row.regex) {
        try {
          new RegExp(row.pattern);
        } catch {
          message.warning(t("task.rulePatternInvalid"));
          return;
        }
      }
    }
    onOk(rows.map(({ pattern, action, insert, regex }) => ({ pattern, action, insert, regex })));
  };

  return (
    <Modal
      open={open}
      title={t("task.ruleModalTitle")}
      width={900}
      onCancel={onCancel}
      footer={null}
      destroyOnClose
      // 与「专有名词」弹窗一致：内容区固定高度，规则过多时内容区出现垂直滚动条。
      styles={{
        body: {
          height: MANAGED_MODAL_BODY_HEIGHT,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        },
      }}
    >
      <div className="st-rule-list" style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
        {rows.map((row) => (
          <div className="st-rule-row" key={row.key}>
            <Input
              className="st-input"
              style={{ width: "26ch" }}
              placeholder={t("task.ruleMatch")}
              value={row.pattern}
              onChange={(e) => patchRow(row.key, { pattern: e.target.value })}
            />
            <Select
              style={{ width: 108, flex: "0 0 auto" }}
              value={row.action}
              options={actionOptions}
              onChange={(action) => patchRow(row.key, { action })}
            />
            <Input.TextArea
              autoSize={{ minRows: 1, maxRows: 3 }}
              style={{ flex: 1, minWidth: 0 }}
              placeholder={row.action === "replace" ? t("task.ruleReplaceText") : t("task.ruleInsert")}
              value={row.insert}
              onChange={(e) => patchRow(row.key, { insert: e.target.value })}
            />
            <Tooltip title={t("task.ruleRegex")}>
              <Space size={4} style={{ flex: "0 0 auto", paddingTop: 2 }}>
                <Switch
                  size="small"
                  checked={row.regex}
                  onChange={(regex) => patchRow(row.key, { regex })}
                />
                <Typography.Text style={{ fontSize: 12 }}>{t("task.ruleRegex")}</Typography.Text>
              </Space>
            </Tooltip>
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeRow(row.key)}
              title={t("act.remove")}
            />
          </div>
        ))}
        <Button type="dashed" size="small" block icon={<PlusOutlined />} onClick={addRow}>
          {t("task.ruleAdd")}
        </Button>
        {rows.length === 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("task.ruleEmpty")}
          </Typography.Text>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12, flex: "0 0 auto" }}>
        <Button onClick={onCancel}>{t("act.cancel")}</Button>
        <Button type="primary" onClick={handleOk}>
          {t("act.save")}
        </Button>
      </div>
    </Modal>
  );
}
