import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button, Empty, Spin, Tabs } from "antd";
import { getTask, type Task } from "../api/client";
import TaskDetail from "../components/TaskDetail";
import TransferPage from "./TransferPage";
import { getErrorMessage } from "../lib/errors";
import { useI18n } from "../i18n";

/** 全屏任务工作区：/tasks/:id?tab=workbench|transfer。顶部页签：工作台 / 文件传输。 */
export default function TaskWorkspacePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useI18n();
  const taskId = Number(id);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
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
              <TaskDetail
                taskId={task.id}
                taskName={task.name}
                skipTts={task.skip_tts}
                onClose={() => navigate("/tasks")}
              />
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
    </div>
  );
}
