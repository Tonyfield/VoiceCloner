import http from "node:http";

/**
 * Standalone mock IndexTTS endpoint for offline testing.
 * Serves SSE `speech.audio.delta` events built from a tiny valid WAV so the
 * client can verify payload + SSE parsing + WAV assembly without a real server.
 *
 * Run: `npm run mock:tts`  (port 20900 by default)
 */
const PORT = Number(process.env.MOCK_TTS_PORT || 20900);

// A minimal 0.1s 16-bit mono 8000Hz WAV (valid RIFF/WAVE).
function makeTinyWav(): Buffer {
  const numSamples = 800; // 0.1s
  const dataSize = numSamples * 2;
  const total = 44 + dataSize;
  const buf = Buffer.alloc(total);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(total - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(8000, 24); // sample rate
  buf.writeUInt32LE(8000 * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url && req.url !== "/health") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        // malformed body must not crash the mock; fall back to defaults
      }
      // eslint-disable-next-line no-console
      console.log(
        `🔐 auth: ${req.headers.authorization || "(无 Authorization 头)"}` +
          ` | input: ${String(payload.input ?? "").slice(0, 120)}` +
          (payload.extra_params ? ` | extra_params: ${JSON.stringify(payload.extra_params)}` : "")
      );
      const wav = makeTinyWav();
      const b64 = wav.toString("base64");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const event = {
        type: "speech.audio.delta",
        audio: b64,
        index: 0,
      };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    });
    return;
  }
  res.writeHead(200);
  res.end("ok");
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`🎧 mock TTS listening on http://127.0.0.1:${PORT}/v1/audio/speech`);
});