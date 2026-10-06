import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { requireAuth } from "../auth/middleware";
import { jobService } from "../services/jobService";

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

/** 后台任务列表（可按 taskId 过滤），最新在前。 */
jobsRouter.get("/", (req: Request, res: Response) => {
  const raw = req.query.taskId;
  const taskId = raw === undefined ? undefined : Number(raw);
  res.json({ jobs: jobService.list(Number.isFinite(taskId) ? (taskId as number) : undefined) });
});

jobsRouter.get("/:id", (req: Request, res: Response) => {
  const job = jobService.get(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json(job);
});

jobsRouter.delete("/:id", (req: Request, res: Response) => {
  const ok = jobService.remove(String(req.params.id));
  res.status(ok ? 200 : 404).json({ ok });
});

/** 下载导出产物（完成后可用）。 */
jobsRouter.get("/:id/download", (req: Request, res: Response) => {
  const job = jobService.get(String(req.params.id));
  if (!job || !job.resultPath || !fs.existsSync(job.resultPath)) {
    res.status(404).json({ error: "产物不存在" });
    return;
  }
  res.download(job.resultPath, job.resultName ?? path.basename(job.resultPath));
});
