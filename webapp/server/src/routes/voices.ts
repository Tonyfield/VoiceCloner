import { Router, type Request, type Response } from "express";
import multer from "multer";
import { voiceService } from "../services/voiceService";
import { getErrorMessage, sendError } from "../shared/errors";
import { logger } from "../logger";

const upload = multer({ storage: multer.memoryStorage() });

export const voicesRouter = Router();

voicesRouter.get("/", (_req: Request, res: Response) => {
  const list = voiceService.list();
  logger.success(`✅ 获取声音列表成功 (${list.length} 个)`);
  res.json(list);
});

voicesRouter.get("/:id/audio", (req: Request, res: Response) => {
  const voice = voiceService.get(Number(req.params.id));
  if (!voice) {
    res.status(404).json({ error: "声音不存在" });
    return;
  }
  const buffer = voiceService.readBuffer(voice.id);
  if (!buffer) {
    res.status(404).json({ error: "声音文件缺失" });
    return;
  }
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Length", String(buffer.byteLength));
  res.end(buffer);
});

voicesRouter.post("/", upload.single("file"), (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "未收到音频文件" });
      return;
    }
    const name = String(req.body?.name ?? "");
    const voice = voiceService.create({
      name,
      fileName: req.file.originalname,
      buffer: req.file.buffer,
    });
    res.status(201).json(voice);
  } catch (e) {
    logger.error(`❌ 上传声音失败: ${getErrorMessage(e)}`);
    sendError(res, 400, e);
  }
});

voicesRouter.delete("/:id", (req: Request, res: Response) => {
  voiceService.remove(Number(req.params.id));
  res.json({ ok: true });
});