import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button, Card, Empty, List, Popconfirm, Progress, Space, Tag, Tooltip, Typography, message,
} from "antd";
import { DeleteOutlined, EditOutlined, PauseOutlined, PlayCircleOutlined, PlusOutlined, SettingOutlined } from "@ant-design/icons";
import type { ModelSpec, Task, Voice } from "../api/client";
import {
  createTask, deleteTask, getModels, getTaskStatus, getTasks, getVoices,
  pauseTask, prepareTask, resumeTask, runTask, updateTask,
} from "../api/client";
import TaskForm from "../components/TaskForm";
import { getErrorMessage } from "../lib/errors";
import { STATUS_META, isSkipTtsBlocked, needsPrepare } from "../lib/taskStatus";
import { usePolling } from "../hooks/usePolling";
import { useI18n } from "../i18n";

export default function TasksPage() {
  // 注意：渲染回调里的 t 是 task，这里给 i18n 的 t 取别名
  const { t: tr } = useI18n();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);

  const showRequestError = useCallback((error: unknown, key?: string) => {
    const content = getErrorMessage(error, tr("error.request"));
    if (key) {
      message.open({ key, type: "error", content });
      return;
    }
    message.error(content);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setTasks(await getTasks());
    } catch (error) {
      showRequestError(error, "tasks-refresh-error");
    }
  }, [showRequestError]);

  useEffect(() => {
    void refresh();
    getModels().then(setModels).catch((error) => showRequestError(error));
    getVoices().then(setVoices).catch((error) => showRequestError(error));
  }, [refresh, showRequestError]);

  const hasActiveTask = tasks.some((t) => t.status === "segmenting" || t.status === "running");
  usePolling(hasActiveTask, () => void refresh(), 2500);

  const onSubmit = async (values: any, file?: File, overwrite?: boolean) => {
    try {
      if (editing) {
        await updateTask(editing.id, {
          name: values.name,
          model_id: values.model_id,
          params: values,
          skip_tts: values.skip_tts,
          file,
        });
      } else {
        await createTask({
          name: values.name,
          model_id: values.model_id,
          params: values,
          skip_tts: values.skip_tts,
          file,
          overwrite,
        });
      }
      message.success(tr("task.saved"));
      setFormOpen(false);
      setEditing(null);
      await refresh();
    } catch (error) {
      showRequestError(error);
    }
  };

  const onDelete = async (id: number) => {
    try {
      await deleteTask(id);
      message.success(tr("task.deleted"));
      await refresh();
    } catch (error) {
      showRequestError(error);
    }
  };

  const onRun = async (task: Task) => {
    if (isSkipTtsBlocked(task)) {
      message.warning(tr("task.noTtsModel"));
      return;
    }

    try {
      if (needsPrepare(task)) {
        const result = await prepareTask(task.id);
        message.info(result.message || tr("task.startedSegmentation"));
      } else if (task.status === "paused") {
        const result = await resumeTask(task.id);
        message.info(result.message || tr("task.startedResume"));
      } else {
        const result = await runTask(task.id);
        const status = await getTaskStatus(task.id);
        message.info(
          result?.message || (status.status === "running" ? tr("task.startedTts") : tr("task.startedProcessing"))
        );
      }
      await refresh();
    } catch (error) {
      showRequestError(error);
    }
  };

  const onPause = async (task: Task) => {
    try {
      const result = await pauseTask(task.id);
      message.info(result.message || tr("task.pauseRequested"));
      await refresh();
    } catch (error) {
      showRequestError(error);
    }
  };

  const openCreate = () => {    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (t: Task) => {
    setEditing(t);
    setFormOpen(true);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Typography.Title level={4} className="page-title" style={{ margin: 0 }}>
          {tr("nav.tasks")}
        </Typography.Title>
        <Space>
          <Button icon={<SettingOutlined />} aria-label={tr("nav.settingsPage")} onClick={() => navigate("/settings")} />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {tr("act.add")}
          </Button>
        </Space>
      </div>

      {tasks.length === 0 && <Empty description={tr("task.empty")} />}

      <List
        grid={{ gutter: 16, column: 1 }}
        dataSource={tasks}
        renderItem={(t) => {
          const statusMeta = STATUS_META[t.status];
          const isRunning = t.status === "running";
          const runDisabled = isSkipTtsBlocked(t) || t.status === "segmenting";
          const runText = needsPrepare(t)
            ? tr("act.resegment")
            : t.status === "paused"
              ? tr("act.resume")
              : t.status === "error"
                ? tr("act.retryTts")
                : tr("act.run");
          const runButton = isRunning ? (
            <Button icon={<PauseOutlined />} onClick={() => void onPause(t)}>
              {tr("act.pause")}
            </Button>
          ) : (
            <Button icon={<PlayCircleOutlined />} onClick={() => void onRun(t)} disabled={runDisabled}>
              {runText}
            </Button>
          );

          return (
          <List.Item>
            <Card className="flat-card" hoverable onClick={() => navigate(`/tasks/${t.id}`)} style={{ borderRadius: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <Space>
                    <Typography.Text strong>{t.name}</Typography.Text>
                    <Tag color={statusMeta.color}>{tr(`st.${t.status}`)}</Tag>
                    {Boolean(t.skip_tts) && <Tag color="cyan">{tr("task.segmentOnly")}</Tag>}
                  </Space>
                  <div className="task-list-meta">
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {tr("task.meta", { time: t.updated_at, count: t.segment_count })}
                    </Typography.Text>
                  </div>
                  {(t.status === "segmenting" || t.status === "running") && (
                    <Progress percent={t.progress} size="small" />
                  )}
                  {t.status === "error" && (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      {t.error}
                    </Typography.Text>
                  )}
                </div>
                <Space onClick={(e) => e.stopPropagation()}>
                  {isSkipTtsBlocked(t) ? (
                    <Tooltip title={tr("task.noTtsModel")}><span>{runButton}</span></Tooltip>
                  ) : runButton}
                  <Popconfirm title={tr("task.confirmDelete")} description={tr("task.confirmDeleteDesc")} onConfirm={() => onDelete(t.id)} okText={tr("act.delete")} okButtonProps={{ danger: true }}>
                    <Button icon={<DeleteOutlined />} danger />
                  </Popconfirm>
                  <Button icon={<EditOutlined />} onClick={() => openEdit(t)} />
                </Space>
              </div>
            </Card>
          </List.Item>
          );
        }}
      />

      <TaskForm
        open={formOpen}
        models={models}
        voices={voices}
        task={editing}
        onCancel={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSubmit={onSubmit}
      />

    </div>
  );
}