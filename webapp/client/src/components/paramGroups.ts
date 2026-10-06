import type { MessageKey } from "../i18n/locales";

/** TTS 参数设置页的分类（页签）。 */
export type ParamGroupKey =
  | "input"
  | "output"
  | "segment"
  | "phonetic"
  | "instruction"
  | "emotion"
  | "advanced";

export interface ParamGroupDef {
  key: ParamGroupKey;
}

/** 页签顺序，与产品定义的分类一致；显示文案取自 `tab.<key>` 文案。 */
export const PARAM_GROUPS: ParamGroupDef[] = [
  { key: "input" },
  { key: "output" },
  { key: "segment" },
  { key: "phonetic" },
  { key: "instruction" },
  { key: "emotion" },
  { key: "advanced" },
];

/**
 * 参数 key → 所属页签。
 * 只映射产品明确列出的参数；未列出的参数统一落到「高级」。
 */
const FIELD_GROUP: Record<string, ParamGroupKey> = {
  // 输入：声音样本、任务类型（文档上传在 TaskForm 中同页渲染）
  voice_file_id: "input",
  task_type: "input",
  // 输出（含原「声音」页）：输出格式、目标时长、音色、语速、随机种子、流式响应、非流式模式、最大 token
  response_format: "output",
  duration_seconds: "output",
  voice: "output",
  speed: "output",
  seed: "output",
  stream: "output",
  non_streaming_mode: "output",
  max_new_tokens: "output",
  // 分段参数：最长分段长度
  segment_max_chars: "segment",
  // 注音参数：语言（自动注音/注音格式/文字增强/专有名词在 TaskForm 中同页渲染）
  language: "phonetic",
  // 指令：启用合成指令 + 指令文本框
  use_instructions: "instruction",
  instructions: "instruction",
  // 感情：情感来源 + 各情感方式
  emotion_mode: "emotion",
  emo_alpha: "emotion",
  emo_text: "emotion",
  emo_vector: "emotion",
  // 高级：首个 codec 分块帧数
  initial_codec_chunk_frames: "advanced",
};

/** 不在参数设置页展示的字段（默认值仍会随表单一并提交）。 */
const HIDDEN_PARAMS = new Set(["model", "ref_audio", "x_vector_only_mode"]);

/** 该参数是否不展示。 */
export function isHiddenParam(key: string): boolean {
  return HIDDEN_PARAMS.has(key);
}

/** 返回参数所属页签；未配置的参数归入「高级」。 */
export function groupOf(key: string): ParamGroupKey {
  return FIELD_GROUP[key] ?? "advanced";
}

/**
 * 参数标题覆盖：模型 schema 之外的统一文案（按参数 key 生效）。
 * 单一维护点——新增/修改文案只改这里，不要在组件里零散打补丁。
 * 文案以 i18n key 形式保存，由组件按当前语种解析。
 */
export const PARAM_TITLE_KEYS: Partial<Record<string, MessageKey>> = {
  voice: "param.title.voice",
  task_type: "param.title.task_type",
  stream_format: "param.title.stream_format",
  stream: "param.title.stream",
  duration_seconds: "param.title.duration_seconds",
  speed: "param.title.speed",
  max_new_tokens: "param.title.max_new_tokens",
  seed: "param.title.seed",
  initial_codec_chunk_frames: "param.title.initial_codec_chunk_frames",
  non_streaming_mode: "param.title.non_streaming_mode",
  response_format: "param.title.response_format",
  emotion_mode: "param.title.emotion_mode",
  emo_alpha: "param.title.emo_alpha",
  emo_text: "param.title.emo_text",
  emo_vector: "param.title.emo_vector",
  language: "param.title.language",
  reference_text: "param.title.reference_text",
  voice_instruction: "param.title.voice_instruction",
  speaker: "param.title.speaker",
  x_vector_only_mode: "param.title.x_vector_only_mode",
  tokens: "param.title.tokens",
  audio_temperature: "param.title.audio_temperature",
  audio_repetition_penalty: "param.title.audio_repetition_penalty",
};

/** 参数说明覆盖（按参数 key 生效）。 */
export const PARAM_HELP_KEYS: Partial<Record<string, MessageKey>> = {
  language: "param.languageHelp",
  seed: "param.help.seed",
  emotion_mode: "param.help.emotion_mode",
  emo_alpha: "param.help.emo_alpha",
  emo_text: "param.help.emo_text",
  emo_vector: "param.help.emo_vector",
};

/**
 * 选项 value → 文案 key（value 保持工程值，仅替换显示）。
 * 例：language 显示「🇨🇳 汉语」，提交仍是 `zh`。
 */
export const PARAM_OPTION_KEYS: Record<string, Record<string, MessageKey>> = {
  language: { zh: "lang.zh", en: "lang.en", ja: "lang.ja", es: "lang.es", ar: "lang.ar" },
  emotion_mode: {
    none: "param.opt.emotion_mode.none",
    text: "param.opt.emotion_mode.text",
    random: "param.opt.emotion_mode.random",
    vector: "param.opt.emotion_mode.vector",
  },
};

/** 需要覆盖的可选值（如注音参数只提供这 5 个语种）。 */
export const PARAM_OPTION_VALUES: Record<string, string[]> = {
  language: ["zh", "en", "ja", "es", "ar"],
};

/** 选项前的 24px 国旗（public/country_flag）。 */
export const PARAM_OPTION_FLAGS: Record<string, Record<string, string>> = {
  language: {
    zh: "china-flag-circular-17757_24.png",
    en: "usa-flag-circular-17882_24.png",
    ja: "japan-flag-circular-17764_24.png",
    es: "spain-flag-circular-17884_24.png",
    ar: "saudi-arabia-circle-rounded-flag-24368_24.png",
  },
};

/** 返回该参数某个选项对应的文案 key（无映射时返回 undefined，展示原值）。 */
export function optionLabelKey(paramKey: string, value: string): MessageKey | undefined {
  return PARAM_OPTION_KEYS[paramKey]?.[value];
}
