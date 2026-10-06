/**
 * IndexTTS 参数键集合与随机种子哨兵。
 * 集中定义 payload 的「顶层键 / Web 任务级内部键」，避免各处散落魔法字符串。
 */

/** 会作为顶层字段发送给 TTS API 的参数键；其余参数归入 extra_params。 */
export const TTS_TOP_LEVEL_KEYS = new Set([
  "model", "voice", "speed", "max_new_tokens", "response_format",
  "language", "seed", "instructions", "task_type", "stream", "stream_format",
  "duration_seconds", "initial_codec_chunk_frames", "non_streaming_mode",
  "x_vector_only_mode",
  "ref_audio", "ref_audio_2", "ref_text", "ambient_sound", "speaker_embedding",
]);

/**
 * Web 任务表单使用的参数（任务级设置或内部表达），不发给 TTS API。
 *
 * 注意：`emo_alpha`、`emo_text`、`emo_vector` 的“原始值”保留在内部键里，
 * 由 buildPayload 依据 emotion_mode 映射成 IndexTTS 的 emotion 参数；
 * 而下面这些「文本增强」开关/规则是程序侧实现（分段/注音阶段已写回文本），
 * IndexTTS 的 speech 接口并不认识，必须过滤掉，避免混进 extra_params。
 */
export const TTS_INTERNAL_KEYS = new Set([
  "name", "model_id", "skip_tts", "phonetic", "phonetic_format",
  "segment_max_chars", "max_chars_per_segment", "voice_file_id", "api_key",
  "use_instructions", "emotion_mode",
  "emo_text", "emo_vector",
  // 文本增强（程序侧，非 IndexTTS 参数）
  "text_rules", "interjection_prefix_enabled", "interjection_prefix",
  "word_gap_enabled", "word_gap", "punct_comma_enabled",
  "epub_start", "epub_end",
]);

/** 任务表单中「随机种子」的哨兵值。 */
export const RANDOM_SEED = -1;

export function nextRandomSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}
