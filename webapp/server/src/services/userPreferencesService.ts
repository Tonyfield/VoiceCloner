import { db } from "../db/database";

/** 删除口径：all=删除全部到期分段音频；unused=仅删除到期且非最新的旧副本。 */
export type AudioRetentionMode = "all" | "unused";

export interface UserPreferences {
  /** 生成音频在后台保留的天数。 */
  audioRetentionDays: number;
  /** 保留期到期后的删除口径。 */
  audioRetentionMode: AudioRetentionMode;
}

/** 可选保留期（天）：1周/2周/3周/1个月/3个月/6个月/9个月/12个月。 */
export const RETENTION_DAY_OPTIONS = [7, 14, 21, 30, 90, 180, 270, 365] as const;
export const RETENTION_MODES: readonly AudioRetentionMode[] = ["unused", "all"];

const DEFAULT_PREFERENCES: UserPreferences = {
  audioRetentionDays: 30,
  audioRetentionMode: "unused",
};

function normalize(raw: unknown): UserPreferences {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const days = Number(obj.audioRetentionDays);
  const mode = String(obj.audioRetentionMode);
  return {
    audioRetentionDays: (RETENTION_DAY_OPTIONS as readonly number[]).includes(days)
      ? days
      : DEFAULT_PREFERENCES.audioRetentionDays,
    audioRetentionMode: mode === "all" || mode === "unused"
      ? mode
      : DEFAULT_PREFERENCES.audioRetentionMode,
  };
}

export const userPreferencesService = {
  get(userId: number): UserPreferences {
    const row = db.prepare("SELECT preferences FROM users WHERE id = ?").get(userId) as
      | { preferences?: string }
      | undefined;
    if (!row) return { ...DEFAULT_PREFERENCES };
    try {
      return normalize(JSON.parse(row.preferences || "{}"));
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  },

  update(userId: number, patch: unknown): UserPreferences {
    const merged = {
      ...this.get(userId),
      ...(patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {}),
    };
    const next = normalize(merged);
    db.prepare("UPDATE users SET preferences = ? WHERE id = ?").run(JSON.stringify(next), userId);
    return next;
  },

  /** 任务为全局资源，保留策略取“归属用户”（首个用户，默认 admin）的偏好。 */
  getEffective(): UserPreferences {
    const row = db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get() as
      | { id: number }
      | undefined;
    return row ? this.get(row.id) : { ...DEFAULT_PREFERENCES };
  },
};
