import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth/middleware";
import { namedEntityService } from "../services/namedEntityService";
import { sendError } from "../shared/errors";
import { logger } from "../logger";

export const namedEntitiesRouter = Router();

namedEntitiesRouter.use(requireAuth);

/** 列表 + 可用类型（供类型下拉）。 */
namedEntitiesRouter.get("/", (_req: Request, res: Response) => {
  res.json({ items: namedEntityService.list(), types: namedEntityService.types() });
});

namedEntitiesRouter.post("/", (req: Request, res: Response) => {
  try {
    const body = (req as any).body || {};
    res.status(201).json({ item: namedEntityService.create(body) });
  } catch (e) {
    sendError(res, 400, e);
  }
});

/** 全局替换：批量改写所有条目的「替换文本」。body: { kind: wrap|connector, value } */
namedEntitiesRouter.post("/apply-global", (req: Request, res: Response) => {
  const body = (req as any).body || {};
  const kind = String(body.kind ?? "");
  const value = String(body.value ?? "");
  if (kind !== "wrap" && kind !== "connector") {
    res.status(400).json({ error: "kind 必须是 wrap | connector" });
    return;
  }
  try {
    const updated = namedEntityService.applyGlobal(kind, value);
    logger.success(`✅ 专有名词全局替换 ${kind}(${JSON.stringify(value)})，共 ${updated} 条`);
    res.json({ ok: true, updated, items: namedEntityService.list() });
  } catch (e) {
    sendError(res, 400, e);
  }
});

namedEntitiesRouter.put("/:id", (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    res.json({ item: namedEntityService.update(id, (req as any).body || {}) });
  } catch (e) {
    sendError(res, 400, e);
  }
});

namedEntitiesRouter.delete("/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!namedEntityService.get(id)) {
    res.status(404).json({ error: "专有名词不存在" });
    return;
  }
  namedEntityService.remove(id);
  res.json({ ok: true });
});
