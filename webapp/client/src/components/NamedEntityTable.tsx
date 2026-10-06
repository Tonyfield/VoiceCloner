import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AutoComplete, Button, Checkbox, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip,
  Typography, message, theme,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import {
  applyNamedEntityGlobal,
  createNamedEntity,
  deleteNamedEntity,
  getNamedEntities,
  updateNamedEntity,
  type NamedEntity,
  type NamedEntityGlobalKind,
  type NamedEntityPatch,
} from "../api/client";
import { getErrorMessage } from "../lib/errors";
import { useI18n } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 数据条数变化时通知外层（用于显示数量）。 */
  onCountChange?: (count: number) => void;
}

/** 专有名词标注管理：复选框 / 序号 / 专有名词 / 类型 / 出现次数 / 替换文本 / 编辑·删除。 */
export default function NamedEntityTable({ open, onClose, onCountChange }: Props) {
  const { t } = useI18n();
  /** 「两侧加」可选值：空 / 单引号 / 双引号，也可自行输入。 */
  const wrapOptions = [
    { label: t("entity.wrapEmpty"), value: "" },
    { label: "'", value: "'" },
    { label: '"', value: '"' },
  ];
  const { token } = theme.useToken();
  const [items, setItems] = useState<NamedEntity[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingEntity, setEditingEntity] = useState("");

  /** 新增专有名词弹窗。 */
  const [addOpen, setAddOpen] = useState(false);
  const [newEntity, setNewEntity] = useState("");
  const [newType, setNewType] = useState<string | undefined>(undefined);

  /** 全局替换控件。 */
  const [wrapValue, setWrapValue] = useState("");
  const [connectorValue, setConnectorValue] = useState("·");

  const countRef = useRef(onCountChange);
  countRef.current = onCountChange;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getNamedEntities();
      setItems(data.items);
      setTypes(data.types);
      countRef.current?.(data.items.length);
    } catch (error) {
      message.error(getErrorMessage(error, t("entity.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const orderOf = useMemo(() => {
    const map = new Map<number, number>();
    items.forEach((item, index) => map.set(item.id, index + 1));
    return map;
  }, [items]);

  const typeOptions = useMemo(() => types.map((type) => ({ label: type, value: type })), [types]);

  const filtered = useMemo(() => {
    const keyword = search.trim();
    return items.filter((item) => {
      if (typeFilter && item.type !== typeFilter) return false;
      if (!keyword) return true;
      return item.entity.includes(keyword) || item.replacement.includes(keyword);
    });
  }, [items, search, typeFilter]);

  /** 新增输入框的重复校验：与已有专有名词同名则警告并阻止添加。 */
  const trimmedNew = newEntity.trim();
  const duplicate = trimmedNew !== "" && items.some((item) => item.entity === trimmedNew);
  const canAdd = trimmedNew !== "" && !duplicate;

  const patch = async (row: NamedEntity, body: NamedEntityPatch) => {
    try {
      const next = await updateNamedEntity(row.id, body);
      setItems((prev) => prev.map((item) => (item.id === next.id ? next : item)));
    } catch (error) {
      message.error(getErrorMessage(error, t("entity.saveFailed")));
    }
  };

  const closeAdd = () => {
    setAddOpen(false);
    setNewEntity("");
    setNewType(undefined);
  };

  const addEntity = async () => {
    if (!canAdd) return;
    try {
      const created = await createNamedEntity({
        entity: trimmedNew,
        type: newType || types[0] || "未分类",
      });
      setItems((prev) => [...prev, created]);
      countRef.current?.(items.length + 1);
      message.success(t("entity.added"));
      closeAdd();
    } catch (error) {
      message.error(getErrorMessage(error, t("entity.addFailed")));
    }
  };

  const removeEntity = async (row: NamedEntity) => {
    try {
      await deleteNamedEntity(row.id);
      setItems((prev) => prev.filter((item) => item.id !== row.id));
      message.success(t("entity.deleted"));
    } catch (error) {
      message.error(getErrorMessage(error, t("entity.deleteFailed")));
    }
  };

  const saveEditing = async (row: NamedEntity) => {
    const entity = editingEntity.trim();
    if (!entity) {
      message.warning(t("entity.emptyWarning"));
      return;
    }
    await patch(row, { entity });
    setEditingId(null);
  };

  const runGlobal = async (kind: NamedEntityGlobalKind, value: string) => {
    setBusy(true);
    try {
      const res = await applyNamedEntityGlobal(kind, value);
      setItems(res.items);
      setEditingId(null);
      message.success(t("entity.updated", { count: res.updated }));
    } catch (error) {
      message.error(getErrorMessage(error, t("entity.globalFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        width={900}
        destroyOnClose
        title={t("entity.title", { count: items.length })}
      >
        <Space wrap style={{ marginBottom: 8 }}>
          <Tooltip title={t("entity.addTooltip")}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)} />
          </Tooltip>
          <span style={{ color: token.colorTextTertiary }}>{t("entity.wrap")}</span>
          <AutoComplete
            value={wrapValue}
            options={wrapOptions}
            onChange={(value) => setWrapValue(value ?? "")}
            style={{ width: 96 }}
            placeholder={t("entity.wrapEmpty")}
          />
          <Button size="small" disabled={busy} onClick={() => void runGlobal("wrap", wrapValue)}>
            {t("act.apply")}
          </Button>
          <span style={{ color: token.colorTextTertiary }}>{t("entity.connector")}</span>
          <Input
            value={connectorValue}
            onChange={(e) => setConnectorValue(e.target.value)}
            style={{ width: 72 }}
            placeholder="·"
          />
          <Button
            size="small"
            disabled={busy}
            onClick={() => void runGlobal("connector", connectorValue)}
          >
            {t("act.apply")}
          </Button>
        </Space>

        <Space wrap style={{ marginBottom: 8 }}>
          <Input.Search
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("entity.searchPlaceholder")}
            allowClear
            style={{ width: 240 }}
          />
          <Select
            value={typeFilter}
            onChange={setTypeFilter}
            options={typeOptions}
            placeholder={t("entity.allTypes")}
            allowClear
            style={{ width: 160 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("entity.hint")}
          </Typography.Text>
        </Space>

        <Table<NamedEntity>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={filtered}
          pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (total) => t("entity.total", { total }) }}
          scroll={{ y: 380 }}
          columns={[
            {
              title: t("entity.colMark"),
              dataIndex: "marked",
              width: 56,
              render: (_: unknown, row) => (
                <Checkbox
                  checked={row.marked}
                  onChange={(e) => void patch(row, { marked: e.target.checked })}
                />
              ),
            },
            {
              title: t("entity.colIndex"),
              width: 60,
              render: (_: unknown, row) => orderOf.get(row.id) ?? "",
            },
            {
              title: t("entity.colEntity"),
              dataIndex: "entity",
              width: 220,
              render: (_: unknown, row) =>
                editingId === row.id ? (
                  <Input
                    size="small"
                    value={editingEntity}
                    autoFocus
                    onChange={(e) => setEditingEntity(e.target.value)}
                    onPressEnter={() => void saveEditing(row)}
                  />
                ) : (
                  <span>{row.entity}</span>
                ),
            },
            {
              title: t("entity.colType"),
              dataIndex: "type",
              width: 150,
              render: (_: unknown, row) => (
                <Select
                  size="small"
                  value={row.type}
                  style={{ width: "100%" }}
                  options={typeOptions}
                  onChange={(value) => void patch(row, { type: value })}
                />
              ),
            },
            {
              title: t("entity.colOccurrences"),
              dataIndex: "occurrences",
              width: 84,
              render: (value: number) => <Tag>{value}</Tag>,
            },
            {
              title: t("entity.colReplacement"),
              dataIndex: "replacement",
              render: (_: unknown, row) => (
                <Input
                  size="small"
                  key={`${row.id}-${row.replacement}`}
                  defaultValue={row.replacement}
                  onBlur={(e) => {
                    const value = e.target.value;
                    if (value !== row.replacement) void patch(row, { replacement: value });
                  }}
                  onPressEnter={(e) => {
                    const value = (e.target as HTMLInputElement).value;
                    if (value !== row.replacement) void patch(row, { replacement: value });
                  }}
                />
              ),
            },
            {
              title: t("entity.colActions"),
              width: 92,
              render: (_: unknown, row) => (
                <Space size={4}>
                  {editingId === row.id ? (
                    <Button
                      size="small"
                      type="text"
                      icon={<SaveOutlined />}
                      onClick={() => void saveEditing(row)}
                    />
                  ) : (
                    <Button
                      size="small"
                      type="text"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditingId(row.id);
                        setEditingEntity(row.entity);
                      }}
                    />
                  )}
                  <Popconfirm title={t("entity.confirmDelete", { entity: row.entity })} onConfirm={() => void removeEntity(row)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        open={addOpen}
        title={t("entity.addTitle")}
        onCancel={closeAdd}
        footer={null}
        width={520}
        destroyOnClose
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Input
            value={newEntity}
            autoFocus
            status={duplicate ? "warning" : undefined}
            placeholder={t("entity.entityPlaceholder")}
            onChange={(e) => setNewEntity(e.target.value)}
            onPressEnter={() => void addEntity()}
            style={{ flex: 1 }}
          />
              {duplicate && (
            <Typography.Text type="warning" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
              {t("entity.duplicate")}
            </Typography.Text>
          )}
        </div>
        <Space style={{ marginTop: 12 }}>
          <Select
            value={newType}
            onChange={setNewType}
            options={typeOptions}
            placeholder={t("entity.typePlaceholder")}
            style={{ width: 160 }}
          />
          <Button type="primary" disabled={!canAdd} onClick={() => void addEntity()}>
            {t("act.add")}
          </Button>
          <Button onClick={closeAdd}>{t("act.cancel")}</Button>
        </Space>
      </Modal>
    </>
  );
}
