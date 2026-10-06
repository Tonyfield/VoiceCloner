import yaml from "js-yaml";
import { db } from "../db/database";
import { logger } from "../logger";

export interface ParamField {
  title?: string;
  type: "string" | "number" | "integer" | "boolean" | "select" | "audioRef" | "text";
  default?: unknown;
  required?: boolean;
  options?: unknown[];
  help?: string;
  /** 依赖字段名：其值为 truthy 时才显示本字段（如 emo_text 依赖 use_emo_text） */
  show_when?: string;
}

export interface ParamSchema {
  label: string;
  params: Record<string, ParamField>;
}

export interface ModelRow {
  id: number;
  name: string;
  api_url: string;
  api_path: string;
  api_key: string;
  parameters_schema_yaml: string;
  created_at: string;
  updated_at: string;
}

/** Parse YAML parameters-schema into a typed object (throws on invalid). */
export function parseParamSchema(yamlText: string): ParamSchema {
  const raw = yaml.load(yamlText || "") as any;
  if (!raw || typeof raw !== "object") {
    throw new Error("parameters schema 必须是 YAML 对象");
  }
  const params = raw.params || {};
  if (!params || typeof params !== "object") {
    throw new Error("parameters schema 需包含 params 映射");
  }
  return {
    label: String(raw.label || ""),
    params: params as Record<string, ParamField>,
  };
}

export const modelService = {
  list(): ModelRow[] {
    const rows = db
      .prepare("SELECT * FROM tts_models ORDER BY id")
      .all() as unknown as ModelRow[];
    return rows.map((r) => ({
      ...r,
      schema: parseParamSchema(r.parameters_schema_yaml),
    })) as unknown as ModelRow[];
  },

  get(id: number): ModelRow | undefined {
    const row = db
      .prepare("SELECT * FROM tts_models WHERE id = ?")
      .get(id) as unknown as ModelRow | undefined;
    return row;
  },

  create(input: Omit<ModelRow, "id" | "created_at" | "updated_at">): number {
    parseParamSchema(input.parameters_schema_yaml); // validate early
    const info = db
      .prepare(
        `INSERT INTO tts_models(name, api_url, api_path, api_key, parameters_schema_yaml)
         VALUES(?, ?, ?, ?, ?)`
      )
      .run(
        input.name,
        input.api_url,
        input.api_path,
        input.api_key,
        input.parameters_schema_yaml
      );
    logger.success(`✅ 模型已添加: ${input.name}`);
    return Number(info.lastInsertRowid);
  },

  update(id: number, input: Partial<ModelRow>): void {
    if (input.parameters_schema_yaml !== undefined) {
      parseParamSchema(input.parameters_schema_yaml);
    }
    const fields: string[] = [];
    const vals: any[] = [];
    for (const key of ["name", "api_url", "api_path", "api_key", "parameters_schema_yaml"]) {
      const v = (input as any)[key];
      if (v !== undefined) {
        fields.push(`"${key}" = ?`);
        vals.push(v);
      }
    }
    if (!fields.length) return;
    fields.push("updated_at = datetime('now')");
    vals.push(id);
    db.prepare(`UPDATE tts_models SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    logger.success(`✅ 模型已更新: id=${id}`);
  },

  remove(id: number): void {
    db.prepare("DELETE FROM tts_models WHERE id = ?").run(id);
    logger.success(`✅ 模型已删除: id=${id}`);
  },
};