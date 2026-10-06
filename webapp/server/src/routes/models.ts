import { Router, type Request, type Response } from "express";
import { modelService } from "../services/modelService";
import { getErrorMessage, sendError } from "../shared/errors";
import { logger } from "../logger";

export const modelsRouter = Router();

modelsRouter.get("/", (_req: Request, res: Response) => {
  const list = modelService.list();
  logger.success(`✅ 获取模型列表成功 (${list.length} 个)`);
  res.json(list);
});

modelsRouter.post("/", (req: Request, res: Response) => {
  const { name, api_url, api_path, api_key, parameters_schema_yaml } = req.body || {};
  if (!name || !api_url) {
    res.status(400).json({ error: "name 与 api_url 为必填项" });
    return;
  }
  try {
    const id = modelService.create({
      name: String(name),
      api_url: String(api_url),
      api_path: String(api_path || "/v1/audio/speech"),
      api_key: String(api_key || ""),
      parameters_schema_yaml: String(parameters_schema_yaml || ""),
    });
    res.json({ id });
  } catch (e) {
    logger.error(`❌ 添加模型失败: ${getErrorMessage(e)}`);
    sendError(res, 400, e);
  }
});

modelsRouter.put("/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "无效 id" });
    return;
  }
  try {
    modelService.update(id, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 400, e);
  }
});

modelsRouter.delete("/:id", (req: Request, res: Response) => {
  modelService.remove(Number(req.params.id));
  res.json({ ok: true });
});