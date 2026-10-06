import { ensureDirs, PORT } from "./config";
import { createApp } from "./app";
import { initDatabase } from "./db/database";
import { logger } from "./logger";
import { taskService } from "./services/taskService";
import { startAudioRetentionScheduler } from "./services/audioRetentionService";

ensureDirs();
initDatabase();
taskService.recoverInterruptedTasks();
// 一次性迁移：旧命名 audio-<key>.<ext> → <key>-<内容hash>.<ext>（幂等，迁移后无旧文件）。
taskService.migrateAllLegacyAudioNames();
// 后台低优先级：按用户偏好清理超过保留期的分段音频。
startAudioRetentionScheduler();

const app = createApp();
app.listen(PORT, () => {
  logger.success(`🚀 VoiceCloner Web 服务已启动: http://localhost:${PORT}`);
});