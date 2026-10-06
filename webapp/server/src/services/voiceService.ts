import fs from "node:fs";
import path from "node:path";
import { db } from "../db/database";
import { VOICES_DIR, MAX_VOICE_BYTES } from "../config";
import { logger } from "../logger";

export interface VoiceRow {
  id: number;
  name: string;
  file_name: string;
  size: number;
  created_at: string;
}

function voicePath(id: number, fileName: string): string {
  const ext = path.extname(fileName) || ".wav";
  return path.join(VOICES_DIR, `voice-${id}${ext}`);
}

export const voiceService = {
  list(): VoiceRow[] {
    return db
      .prepare("SELECT * FROM voices ORDER BY id")
      .all() as unknown as VoiceRow[];
  },

  /** Persist an uploaded custom voice; name defaults to original filename. */
  create(input: { name?: string; fileName: string; buffer: Buffer }): VoiceRow {
    if (input.buffer.byteLength > MAX_VOICE_BYTES) {
      throw new Error(`声音文件不能超过 ${Math.floor(MAX_VOICE_BYTES / 1024 / 1024)}MB`);
    }
    const name = (input.name || path.parse(input.fileName).name).trim() || "voice";
    const info = db
      .prepare("INSERT INTO voices(name, file_name, size) VALUES(?, ?, ?)")
      .run(name, input.fileName, input.buffer.byteLength);
    const id = Number(info.lastInsertRowid);
    fs.writeFileSync(voicePath(id, input.fileName), input.buffer);
    logger.success(`✅ 声音已上传: ${name} (${input.buffer.byteLength} bytes)`);
    return this.get(id)!;
  },

  get(id: number): VoiceRow | undefined {
    return db.prepare("SELECT * FROM voices WHERE id = ?").get(id) as unknown as VoiceRow | undefined;
  },

  readBuffer(id: number): Buffer | null {
    const row = this.get(id);
    if (!row) return null;
    const p = voicePath(id, row.file_name);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  },

  remove(id: number): void {
    const row = this.get(id);
    if (row) {
      const p = voicePath(id, row.file_name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    db.prepare("DELETE FROM voices WHERE id = ?").run(id);
    logger.success(`✅ 声音已删除: id=${id}`);
  },
};