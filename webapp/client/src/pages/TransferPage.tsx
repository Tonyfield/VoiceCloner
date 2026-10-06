import { useCallback, useEffect, useState } from "react";
import { Button, Card, Empty, Progress, Space, Tag, Typography, message } from "antd";
import { DeleteOutlined, DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { deleteJob, downloadJobResult, listJobs, type JobRecord, type JobStatus } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { getErrorMessage } from "../lib/errors";
import { useI18n } from "../i18n";

/** 状态 → 文案 key。 */
const STATUS_KEY: Record<JobStatus, string> = {
  queued: "transfer.statusQueued",
  running: "transfer.statusRunning",
  done: "transfer.statusDone",
  error: "transfer.statusError",
};

const STATUS_COLOR: Record<JobStatus, string> = {
  queued: "default",
  running: "processing",
  done: "success",
  error: "error",
};

/**
 * 文件传输：后台导出/清理任务的进度（百分比 + 已处理/总数）与日志。
 * 传入 taskId 时只显示该任务的任务（任务工作区页签内使用）。
 */
export default function TransferPage({ taskId }: { taskId?: number }) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setJobs(await listJobs(taskId));
    } catch (error) {
      message.error(getErrorMessage(error, t("error.request")));
    }
  }, [t, taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActive = jobs.some((job) => job.status === "queued" || job.status === "running");
  usePolling(hasActive, () => void refresh(), 1500);

  const onDownload = async (job: JobRecord) => {
    if (!job.resultName) return;
    try {
      await downloadJobResult(job.id, job.resultName);
    } catch (error) {
      message.error(getErrorMessage(error, t("error.request")));
    }
  };

  const onDelete = async (id: string) => {
    setBusy(true);
    try {
      await deleteJob(id);
      await refresh();
    } catch (error) {
      message.error(getErrorMessage(error, t("error.request")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Typography.Title level={4} className="page-title" style={{ margin: 0 }}>
          {t("nav.transfer")}
        </Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
          {t("act.refresh")}
        </Button>
      </div>

      {jobs.length === 0 && <Empty description={t("transfer.empty")} />}

      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        {jobs.map((job) => {
          const statusKey = STATUS_KEY[job.status] as Parameters<typeof t>[0];
          return (
            <Card key={job.id} className="flat-card" style={{ borderRadius: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <Typography.Text strong>{job.taskName}</Typography.Text>
                <Tag>{job.type === "export" ? t("detail.export") : t("act.delete")}</Tag>
                <Tag color={STATUS_COLOR[job.status]}>{t(statusKey)}</Tag>
                <div style={{ flex: 1 }} />
                {job.status === "done" && job.resultName && (
                  <Button type="primary" icon={<DownloadOutlined />} onClick={() => void onDownload(job)}>
                    {t("transfer.download")}
                  </Button>
                )}
                <Button icon={<DeleteOutlined />} danger disabled={busy} onClick={() => void onDelete(job.id)} />
              </div>

              {(job.status === "running" || job.status === "queued") && (
                <Progress percent={job.percent} style={{ marginTop: 8 }} />
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
                {job.percent}% · {job.processed}/{job.total}
                {job.message ? ` · ${job.message}` : ""}
              </Typography.Text>
              {job.error && (
                <Typography.Text type="danger" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
                  {job.error}
                </Typography.Text>
              )}

              {job.logs.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("transfer.logs")}
                  </Typography.Text>
                  <div
                    style={{
                      marginTop: 4,
                      maxHeight: 140,
                      overflow: "auto",
                      padding: 8,
                      borderRadius: 8,
                      background: "var(--vc-code-bg)",
                      color: "var(--vc-code-text)",
                      fontSize: 12,
                      fontFamily: "monospace",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {job.logs.slice(-50).join("\n")}
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </Space>
    </div>
  );
}
