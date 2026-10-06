import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth/middleware";
import { authService } from "../services/authService";
import { userPreferencesService } from "../services/userPreferencesService";
import { logger } from "../logger";

export const authRouter = Router();

authRouter.post("/login", (req: Request, res: Response) => {
  const username = String(req.body?.username ?? "");
  const password = String(req.body?.password ?? "");
  if (!username || !password) {
    res.status(400).json({ error: "用户名或密码不能为空" });
    return;
  }
  const user = authService.authenticate(username, password);
  if (!user) {
    logger.error("❌ 登录失败：用户名或密码错误");
    res.status(401).json({ error: "用户名或密码错误" });
    return;
  }
  logger.success(`✅ 用户 ${user.username} 登录成功`);
  res.json({ token: authService.issueToken(user), user });
});

authRouter.post("/change-password", requireAuth, (req: Request, res: Response) => {
  const oldPassword = String(req.body?.oldPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  if (!oldPassword || !newPassword) {
    res.status(400).json({ error: "旧密码和新密码不能为空" });
    return;
  }
  const result = authService.changePassword(req.auth!.uid, oldPassword, newPassword);
  if (result === "not_found") {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  if (result === "wrong_password") {
    res.status(400).json({ error: "旧密码错误" });
    return;
  }
  logger.success(`✅ 用户 ${req.auth!.username} 修改密码成功`);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req: Request, res: Response) => {
  res.json({ user: { id: req.auth!.uid, username: req.auth!.username } });
});

authRouter.get("/preferences", requireAuth, (req: Request, res: Response) => {
  res.json(userPreferencesService.get(req.auth!.uid));
});

authRouter.put("/preferences", requireAuth, (req: Request, res: Response) => {
  const next = userPreferencesService.update(req.auth!.uid, req.body || {});
  logger.info(`⚙️ 用户 ${req.auth!.username} 更新偏好: ${JSON.stringify(next)}`);
  res.json(next);
});
