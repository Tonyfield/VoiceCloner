import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button, Empty, Spin, Tabs, Tooltip, Typography, message } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import {
  getModels,
  getTask,
  getVoices,
  updateTask,
  type ModelSpec,
  type Task,
  type Voice,
} from "../api/client";
import TaskDetail from "../components/TaskDetail";
import TaskForm from "../components/TaskForm";
import TransferPage from "./TransferPage";
import { getErrorMessage } from "../lib/errors";
import { useI18n } from "../i18n";

/**
 * 全屏任务工作区：/tasks/:id?tab=workbench|transfer。
 * 第 1 行：任务名称 +「配置」（齿轮，悬浮提示）；第 2 行：工作台 / 文件传输 页签。
 */
export default function TaskWorkspacePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useI18n();
  const taskId = Number(id);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 递增以触发工作区重新加载（配置保存后）。 */
  const [reloadToken, setReloadToken] = useState(0);
  const [configOpen, setConfigOpen] = useState(false);
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const activeTab = searchParams.get("tab") === "transfer" ? "transfer" : "workbench";

  useEffect(() => {
    if (!Number.isFinite(taskId)) {
      setError(t("task.empty"));
      return;
    }
    getTask(taskId)
      .then(setTask)
      .catch((e) => setError(getErrorMessage(e, t("error.request"))));
  }, [taskId, t]);

  /** 打开「配置」：拉取任务与模型/声音后弹出编辑表单。 */
  const openConfig = useCallback(async () => {
    try {
      const [current, modelList, voiceList] = await Promise.all([getTask(taskId), getModels(), getVoices()]);
      setTask(current);
      setModels(modelList);
      setVoices(voiceList);
      setConfigOpen(true);
    } catch (configError) {
      message.error(getErrorMessage(configError, t("error.request")));
    }
  }, [taskId, t]);

  const submitConfig = useCallback(
    async (values: any, file?: File) => {
      try {
        await updateTask(taskId, {
          name: values.name,
          model_id: values.model_id,
          params: values,
          skip_tts: values.skip_tts,
          file,
        });
        message.success(t("task.saved"));
        setConfigOpen(false);
        setTask(await getTask(taskId));
        setReloadToken((n) => n + 1);
      } catch (configError) {
        message.error(getErrorMessage(configError, t("error.request")));
      }
    },
    [taskId, t]
  );

  if (error) {
    return (
      <Empty description={error} style={{ padding: 48 }}>
        <Button onClick={() => navigate("/tasks")}>{t("act.back")}</Button>
      </Empty>
    );
  }
  if (!task) {
    return (
      <div style={{ textAlign: "center", padding: 48 }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ height: "calc(100vh - 48px)", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* 第 1 行：任务名称 + 配置（仅图标，悬浮提示） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flex: "0 0 auto" }}>
        <Typography.Text strong style={{ fontSize: 16 }}>{task.name}</Typography.Text>
        <Tooltip title={t("detail.config")}>
          <Button
            size="small"
            type="text"
            icon={<SettingOutlined />}
            aria-label={t("detail.config")}
            onClick={() => void openConfig()}
          />
        </Tooltip>
      </div>

      {/* 第 2 行：工作台 / 文件传输 */}
      <Tabs
        className="task-workspace-tabs"
        activeKey={activeTab}
        onChange={(key) =>
          navigate(key === "transfer" ? `/tasks/${task.id}?tab=transfer` : `/tasks/${task.id}`)
        }
        items={[
          {
            key: "workbench",
            label: t("detail.tabWorkbench"),
            children: (
              <TaskDetail taskId={task.id} skipTts={task.skip_tts} reloadToken={reloadToken} />
            ),
          },
          {
            key: "transfer",
            label: t("detail.tabTransfer"),
            children: (
              <div className="task-workspace-pane">
                <TransferPage taskId={task.id} />
              </div>
            ),
          },
        ]}
      />

      <TaskForm
        open={configOpen}
        models={models}
        voices={voices}
        task={task}
        onCancel={() => setConfigOpen(false)}
        onSubmit={submitConfig}
      />
    </div>
  );
}
