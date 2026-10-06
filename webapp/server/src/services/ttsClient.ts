import { formatLogData, logger } from "../logger";
import {
  RANDOM_SEED,
  TTS_INTERNAL_KEYS,
  TTS_TOP_LEVEL_KEYS,
  nextRandomSeed,
} from "./ttsParams";

/**
 * IndexTTS HTTP/SSE 客户端：URL 拼接、请求发送、SSE 音频重组、WAV 头修复。
 * payload 的业务变换在 `buildPayload` 中完成；键集合与随机种子见 `ttsParams`。
 */

export interface TtsModelRef {
  name: string;
  apiUrl: string;
  apiPath: string;
  apiKey: string;
  parameterDefaults?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildUrl(apiUrl: string, apiPath: string): string {
  return apiUrl.replace(/\/+$/, "") + "/" + apiPath.replace(/^\/+/, "");
}

export function buildPayload(
  text: string,
  model: TtsModelRef,
  params: Record<string, unknown>,
  refAudioDataUrl?: string
): Record<string, unknown> {
  const payload: Record<string, unknown> = { input: text };
  const effectiveParams = {
    ...(model.parameterDefaults || {}),
    ...(params || {}),
  };
  const extras: Record<string, unknown> = isRecord(effectiveParams.extra_params)
    ? { ...effectiveParams.extra_params }
    : {};

  for (const [key, value] of Object.entries(effectiveParams)) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "extra_params" || TTS_INTERNAL_KEYS.has(key)) continue;
    if (key === "instructions" && effectiveParams.use_instructions === false) continue;
    if (key === "seed" && (value === RANDOM_SEED || value === "random")) {
      payload.seed = nextRandomSeed();
      continue;
    }
    if (TTS_TOP_LEVEL_KEYS.has(key)) payload[key] = value;
    else extras[key] = value;
  }

  // Emotion controls are mutually exclusive and may all be off: only emit the
  // params of the selected mode (never send false switches or an all-zero vector).
  const emoMode = effectiveParams.emotion_mode;
  const emoText = effectiveParams.emo_text;
  const emoVector = effectiveParams.emo_vector;
  if (emoMode === "text") {
    extras.use_emo_text = true;
    if (typeof emoText === "string" && emoText.trim()) extras.emo_text = emoText;
  } else if (emoMode === "random") {
    extras.use_random = true;
  } else if (emoMode === "vector") {
    if (Array.isArray(emoVector)) extras.emo_vector = emoVector;
  }

  if (!payload.model) payload.model = model.name;
  if (payload.voice === undefined) payload.voice = "default";
  if (refAudioDataUrl) payload.ref_audio = refAudioDataUrl;
  if (Object.keys(extras).length) payload.extra_params = extras;

  // The TTS API treats `stream=true`, `stream_format='sse'` or `'audio'` as
  // streaming, and streaming only accepts response_format 'pcm'/'wav'. When a
  // different format (mp3/flac/…) is selected, fall back to a non-streaming
  // request so the chosen format is accepted instead of rejected with HTTP 400.
  const responseFormat = payload.response_format;
  const wantsStream =
    payload.stream === true ||
    payload.stream_format === "sse" ||
    payload.stream_format === "audio";
  const formatSupportsStream =
    responseFormat === undefined || responseFormat === "pcm" || responseFormat === "wav";
  if (wantsStream && !formatSupportsStream) {
    logger.warn(
      `⚠️ response_format=${String(responseFormat)} 不支持流式，已关闭流式（stream=false，移除 stream_format）`
    );
    delete payload.stream_format;
    payload.stream = false;
  }

  return payload;
}

export function audioToDataUrl(buffer: Buffer, mime = "audio/wav"): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/** Fix RIFF/WAVE size fields (port of _repair_wav_header). */
export function repairWavHeader(audio: Buffer): Buffer {
  if (
    audio.length < 44 ||
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return audio;
  }
  let chunkOffset = 12;
  let dataChunkOffset = -1;
  while (chunkOffset + 8 <= audio.length) {
    const id = audio.toString("ascii", chunkOffset, chunkOffset + 4);
    const size = audio.readUInt32LE(chunkOffset + 4);
    if (id === "data") {
      dataChunkOffset = chunkOffset;
      break;
    }
    if (size === 0xffffffff) break;
    chunkOffset += 8 + size + (size & 1);
  }
  if (dataChunkOffset < 0) {
    throw new Error("SSE 音频中没有找到 WAV data 块");
  }
  const riffSize = audio.length - 8;
  const dataSize = audio.length - dataChunkOffset - 8;
  const repaired = Buffer.from(audio);
  repaired.writeUInt32LE(riffSize, 4);
  repaired.writeUInt32LE(dataSize, dataChunkOffset + 4);
  return repaired;
}

/** Parse a full SSE response body and reassemble audio (port of extract_sse_audio). */
export function extractSseAudio(content: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let sawSseData = false;

  const text = content.toString("utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.startsWith("data:")) continue;
    sawSseData = true;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    let event: { type?: string; audio?: string };
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error("SSE data 不是有效 JSON");
    }
    if (event.type !== "speech.audio.delta" || !event.audio) continue;
    chunks.push(Buffer.from(event.audio, "base64"));
  }

  if (!sawSseData) return content;
  if (!chunks.length) throw new Error("SSE 响应中没有 speech.audio.delta 音频");
  return repairWavHeader(Buffer.concat(chunks));
}

export interface SynthesizeOptions {
  apiUrl: string;
  apiPath: string;
  apiKey: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
  /** 外部取消信号（用于“停止任务”），触发时中止当前请求。 */
  signal?: AbortSignal;
}

export interface SynthesizeResult {
  audio: Buffer;
  /** 上游 HTTP 状态码 */
  status: number;
}

export async function synthesizeText(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  const url = buildUrl(opts.apiUrl, opts.apiPath);
  logger.info(`📡 [POST] ${url}`);
  const controller = new AbortController();
  const external = opts.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 120000
  );
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts.payload),
      signal: controller.signal,
    });
    logger.info(`📡 TTS response HTTP ${res.status} (${url})`);
    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      const safeBody = formatLogData(body);
      logger.error(`❌ TTS error response HTTP ${res.status} (${url}):\n${safeBody}`);
      const err = new Error(`TTS API 返回 HTTP ${res.status} (${url}): ${safeBody.slice(0, 500)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { audio: extractSseAudio(buffer), status: res.status };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      if (external?.aborted) {
        const stopped = new Error("已停止合成");
        stopped.name = "TaskStopped";
        throw stopped;
      }
      throw new Error(`TTS 请求超时 (${url})`);
    }
    if (e instanceof Error && e.message.startsWith("TTS API 返回")) throw e;
    throw new Error(`TTS 服务不可用 (${url}): ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}