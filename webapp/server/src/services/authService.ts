import { db } from "../db/database";
import { signToken } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";

export interface AuthUser {
  id: number;
  username: string;
}

/** 用户认证与凭据变更（routes 不直接访问数据库）。 */
export const authService = {
  /** 校验用户名/密码；失败返回 null。 */
  authenticate(username: string, password: string): AuthUser | null {
    const row = db
      .prepare("SELECT id, username, password_sha256 FROM users WHERE username = ?")
      .get(username) as { id: number; username: string; password_sha256: string } | undefined;
    if (!row || !verifyPassword(password, row.password_sha256)) return null;
    return { id: row.id, username: row.username };
  },

  /** 签发访问令牌。 */
  issueToken(user: AuthUser): string {
    return signToken({ uid: user.id, username: user.username });
  },

  /** 校验旧密码并写入新密码。 */
  changePassword(
    uid: number,
    oldPassword: string,
    newPassword: string
  ): "ok" | "not_found" | "wrong_password" {
    const row = db
      .prepare("SELECT id, password_sha256 FROM users WHERE id = ?")
      .get(uid) as { id: number; password_sha256: string } | undefined;
    if (!row) return "not_found";
    if (!verifyPassword(oldPassword, row.password_sha256)) return "wrong_password";
    db.prepare("UPDATE users SET password_sha256 = ? WHERE id = ?").run(
      hashPassword(newPassword),
      row.id
    );
    return "ok";
  },
};
