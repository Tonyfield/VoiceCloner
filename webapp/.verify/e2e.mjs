// E2E verification for VoiceCloner webapp (runs against http://localhost:3000)
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3000/api";
const DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const results = [];
const fail = (msg) => { results.push(`FAIL: ${msg}`); throw new Error(msg); };
const ok = (msg) => results.push(`OK: ${msg}`);

async function j(res) {
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { fail(`bad json: ${text.slice(0,200)}`); }
  if (!res.ok) fail(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function waitForTask(id, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await j(await fetch(`${BASE}/tasks/${id}`, { headers: H }));
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`task ${id} timed out: ${JSON.stringify(last)}`);
}

// --- tiny wav fixture ---
function makeWav() {
  const b = Buffer.alloc(52);
  b.write("RIFF", 0); b.writeUInt32LE(36 + 8, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(8, 40);
  return b;
}

// 1) login + me
const login = await j(await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "StanislawLem" }) }));
const H = { Authorization: `Bearer ${login.token}`, };
const me = await j(await fetch(`${BASE}/auth/me`, { headers: H }));
if (me.user.username !== "admin") fail("me.username");
ok(`login + /me: ${me.user.username}`);

// pre-sweep leftover test data so reruns are deterministic
for (const m of await j(await fetch(`${BASE}/models`, { headers: H }))) {
  if (m.name.startsWith("IndexTTS-e2e-") || m.name.startsWith("坏模型-")) await fetch(`${BASE}/models/${m.id}`, { method: "DELETE", headers: H });
}
for (const t of await j(await fetch(`${BASE}/tasks`, { headers: H }))) {
  if (t.name.startsWith("E2E-")) await fetch(`${BASE}/tasks/${t.id}`, { method: "DELETE", headers: H });
}
for (const v of await j(await fetch(`${BASE}/voices`, { headers: H }))) {
  if (v.name.startsWith("测试音色") || v.name.startsWith("调试音色")) await fetch(`${BASE}/voices/${v.id}`, { method: "DELETE", headers: H });
}
ok("pre-sweep done");

// 2) models CRUD
const U = Date.now().toString(36);
const schema = fs.readFileSync(path.join(DIR, "schema.yaml"), "utf8");
const model = await j(await fetch(`${BASE}/models`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ name: `IndexTTS-e2e-${U}`, api_url: "http://127.0.0.1:20900", api_path: "/v1/audio/speech", api_key: "", parameters_schema_yaml: schema }) }));
const mid = model.id;
const mlist = await j(await fetch(`${BASE}/models`, { headers: H }));
if (!mlist.some((m) => m.id === mid)) fail("model in list");
ok(`models create id=${mid}, list=${mlist.length}`);
await j(await fetch(`${BASE}/models/${mid}`, { method: "PUT", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ api_url: "http://127.0.0.1:20900" }) }));
ok("model update");

// 3) voices upload + list + audio
const wav = makeWav();
const fd = new FormData();
fd.append("name", `测试音色-${U}`);
fd.append("file", new Blob([wav], { type: "audio/wav" }), "test-voice.wav");
const voice = await j(await fetch(`${BASE}/voices`, { method: "POST", headers: H, body: fd }));
if (!(voice.size > 0)) fail("voice size");
const vlist = await j(await fetch(`${BASE}/voices`, { headers: H }));
if (!vlist.some((v) => v.id === voice.id)) fail("voice in list");
const audioRes = await fetch(`${BASE}/voices/${voice.id}/audio`, { headers: H });
if (audioRes.status !== 200) fail(`voice audio http ${audioRes.status}`);
ok(`voices upload id=${voice.id}, list=${vlist.length}, audio-ok`);

// 4) task skip-tts: create -> ready -> info/segments -> compat run -> delete
const tfd = new FormData();
tfd.append("name", "E2E-分段任务");
tfd.append("skip_tts", "true");
tfd.append("file", new Blob([fs.readFileSync(path.join(DIR, "sample.txt"))], { type: "text/plain" }), "sample.txt");
const task = await j(await fetch(`${BASE}/tasks`, { method: "POST", headers: H, body: tfd }));
const tid = task.id;
if (!["segmenting", "ready"].includes(task.status)) fail(`skip-tts create status ${task.status}`);
const skipReady = task.status === "ready" ? task : await waitForTask(tid, (current) => current.status === "ready");
const skipInfo = await j(await fetch(`${BASE}/tasks/${tid}/info`, { headers: H }));
if (!(skipInfo.segmentCount > 0)) fail(`skip-tts info segmentCount=${skipInfo.segmentCount}`);
const skipDetail = await j(await fetch(`${BASE}/tasks/${tid}`, { headers: H }));
if (!Array.isArray(skipDetail.files)) fail("skip-tts detail files missing");
if (skipDetail.files.some((name) => name.startsWith("audio-"))) fail(`skip-tts should not create audio on prepare: ${JSON.stringify(skipDetail.files)}`);
const skipSegments = await j(await fetch(`${BASE}/tasks/${tid}/segments`, { headers: H }));
if (!Array.isArray(skipSegments.segments) || skipSegments.segments.length < 1) fail("skip-tts segments missing");
const skipFirstKey = skipSegments.segments[0]?.key;
if (!skipFirstKey) fail("skip-tts first segment key missing");
const autoPhoneticRes = await fetch(`${BASE}/tasks/${tid}/segments/${skipFirstKey}/auto-phonetic`, {
  method: "POST",
  headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "堂吉诃德" }),
});
if (autoPhoneticRes.status !== 200) fail(`auto-phonetic http ${autoPhoneticRes.status}`);
const autoPhonetic = await autoPhoneticRes.json();
if (autoPhonetic.text !== "堂吉诃德") fail(`auto-phonetic text ${JSON.stringify(autoPhonetic)}`);
if (!String(autoPhonetic.phonetic).includes("phoneme") || !String(autoPhonetic.phonetic).includes("堂吉诃德")) {
  fail(`auto-phonetic phonetic ${JSON.stringify(autoPhonetic)}`);
}
const emptyTtsRes = await fetch(`${BASE}/tasks/${tid}/tts`, {
  method: "POST",
  headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ keys: [] }),
});
const emptyTtsBody = await emptyTtsRes.json();
if (emptyTtsRes.status !== 400) fail(`skip-tts empty keys should 400: ${emptyTtsRes.status} ${JSON.stringify(emptyTtsBody)}`);
const skipReadyAfterEmpty = await j(await fetch(`${BASE}/tasks/${tid}`, { headers: H }));
if (skipReadyAfterEmpty.status !== "ready") fail(`skip-tts empty keys changed status to ${skipReadyAfterEmpty.status}`);
const skipRun = await j(await fetch(`${BASE}/tasks/${tid}/run`, { method: "POST", headers: H }));
if (skipRun?.ok !== true) fail(`skip-tts run response ${JSON.stringify(skipRun)}`);
const skipDone = await waitForTask(
  tid,
  (current) => current.status === "done" && Array.isArray(current.files) && current.files.every((name) => !name.startsWith("audio-")),
);
if (skipDone.progress !== 100) fail(`skip-tts done progress ${skipDone.progress}`);
ok(`task skip-tts: create=${task.status}, ready=${skipReady.status}, segments=${skipInfo.segmentCount}, compat-run=${skipDone.status}`);
await j(await fetch(`${BASE}/tasks/${tid}`, { method: "DELETE", headers: H }));
ok("task deleted");

// 5) check-name conflict hint
const cn = await j(await fetch(`${BASE}/tasks/check-name`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ name: "E2E-分段任务" }) }));
if (cn.exists !== false) fail("check-name exists should be false after delete");
ok("check-name: no conflict after delete");

// 6) selected-segment TTS -> run all -> delete
const stfd = new FormData();
stfd.append("name", "E2E-选中TTS");
stfd.append("model_id", String(mid));
stfd.append("skip_tts", "false");
stfd.append("file", new Blob([fs.readFileSync(path.join(DIR, "sample.txt"))], { type: "text/plain" }), "sample.txt");
const selectiveTask = await j(await fetch(`${BASE}/tasks`, { method: "POST", headers: H, body: stfd }));
if (!["segmenting", "ready"].includes(selectiveTask.status)) fail(`selected tts create status ${selectiveTask.status}`);
const selectiveTid = selectiveTask.id;
await (selectiveTask.status === "ready" ? Promise.resolve(selectiveTask) : waitForTask(selectiveTid, (current) => current.status === "ready"));
const selectiveSegments = await j(await fetch(`${BASE}/tasks/${selectiveTid}/segments`, { headers: H }));
if (!Array.isArray(selectiveSegments.segments) || selectiveSegments.segments.length < 2) {
  fail(`selected tts segments < 2: ${JSON.stringify(selectiveSegments)}`);
}
const selectiveKey = selectiveSegments.segments[0]?.key;
if (!selectiveKey) fail("selected tts first segment key missing");
const selectiveAudio = `audio-${selectiveKey}.wav`;
const selectiveTtsStart = await fetch(`${BASE}/tasks/${selectiveTid}/tts`, {
  method: "POST",
  headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ keys: [selectiveKey] }),
});
if (selectiveTtsStart.status !== 202) fail(`selected tts start http ${selectiveTtsStart.status}`);
await j(selectiveTtsStart);
const selectiveReady = await waitForTask(
  selectiveTid,
  (current) => current.status === "ready" && Array.isArray(current.files) && current.files.filter((name) => name.startsWith("audio-")).length === 1 && current.files.includes(selectiveAudio),
);
const selectivePartialAudio = selectiveReady.files.filter((name) => name.startsWith("audio-"));
if (selectivePartialAudio.length !== 1 || selectivePartialAudio[0] !== selectiveAudio) {
  fail(`selected tts partial audio files ${JSON.stringify(selectivePartialAudio)}`);
}
const selectiveRun = await fetch(`${BASE}/tasks/${selectiveTid}/run`, { method: "POST", headers: H });
if (selectiveRun.status !== 202) fail(`selected tts run http ${selectiveRun.status}`);
await j(selectiveRun);
const selectiveDone = await waitForTask(
  selectiveTid,
  (current) => current.status === "done" && Array.isArray(current.files) && current.files.filter((name) => name.startsWith("audio-")).length === current.segment_count && current.files.includes(selectiveAudio),
);
const selectiveDoneAudio = selectiveDone.files.filter((name) => name.startsWith("audio-"));
if (selectiveDoneAudio.length !== selectiveDone.segment_count) {
  fail(`selected tts final audio count ${selectiveDoneAudio.length}/${selectiveDone.segment_count}`);
}
if (!selectiveDoneAudio.includes(selectiveAudio)) fail(`selected tts final audio missing ${selectiveAudio}`);
ok(`selected tts task: partial=${selectivePartialAudio[0]}, final=${selectiveDoneAudio.length}/${selectiveDone.segment_count}`);
await j(await fetch(`${BASE}/tasks/${selectiveTid}`, { method: "DELETE", headers: H }));
ok("selected tts task deleted");

// 7) change password -> old fails -> restore
await j(await fetch(`${BASE}/auth/change-password`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ oldPassword: "StanislawLem", newPassword: "NewPass123" }) }));
const oldRes = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "StanislawLem" }) });
if (oldRes.status !== 401) fail(`old password should fail, got ${oldRes.status}`);
const newLogin = await j(await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "NewPass123" }) }));
await j(await fetch(`${BASE}/auth/change-password`, { method: "POST", headers: { Authorization: `Bearer ${newLogin.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ oldPassword: "NewPass123", newPassword: "StanislawLem" }) }));
ok("change-password: old rejected, new accepted, restored");

// 8) unreachable TTS -> error message contains URL
const bad = await j(await fetch(`${BASE}/models`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ name: `坏模型-${U}`, api_url: "http://127.0.0.1:29999", parameters_schema_yaml: schema }) }));
const btfd = new FormData();
btfd.append("name", "E2E-坏服务");
btfd.append("model_id", String(bad.id));
btfd.append("skip_tts", "false");
btfd.append("file", new Blob([fs.readFileSync(path.join(DIR, "sample.txt"))], { type: "text/plain" }), "sample.txt");
const bt = await j(await fetch(`${BASE}/tasks`, { method: "POST", headers: H, body: btfd }));
if (!["segmenting", "ready"].includes(bt.status)) fail(`bad task create status ${bt.status}`);
await (bt.status === "ready" ? Promise.resolve(bt) : waitForTask(bt.id, (current) => current.status === "ready"));
const badRun = await fetch(`${BASE}/tasks/${bt.id}/run`, { method: "POST", headers: H });
if (badRun.status !== 202) fail(`bad task run http ${badRun.status}`);
await j(badRun);
const bs = await waitForTask(bt.id, (current) => current.status === "error");
if (bs.status !== "error") fail(`unreachable should error, got ${bs.status}`);
if (!String(bs.error).includes("127.0.0.1:29999")) fail(`error missing URL: ${bs.error}`);
ok(`unreachable TTS error contains URL: ${bs.error.slice(0, 80)}`);
await j(await fetch(`${BASE}/tasks/${bt.id}`, { method: "DELETE", headers: H }));
await j(await fetch(`${BASE}/models/${bad.id}`, { method: "DELETE", headers: H }));

// cleanup model + voice + any leftover e2e data
await j(await fetch(`${BASE}/models/${mid}`, { method: "DELETE", headers: H }));
await j(await fetch(`${BASE}/voices/${voice.id}`, { method: "DELETE", headers: H }));
const allModels = await j(await fetch(`${BASE}/models`, { headers: H }));
for (const m of allModels) {
  if (m.name.startsWith("IndexTTS-e2e-") || m.name.startsWith("坏模型-")) {
    await fetch(`${BASE}/models/${m.id}`, { method: "DELETE", headers: H });
  }
}
const allTasks = await j(await fetch(`${BASE}/tasks`, { headers: H }));
for (const t of allTasks) {
  if (t.name.startsWith("E2E-")) await fetch(`${BASE}/tasks/${t.id}`, { method: "DELETE", headers: H });
}
const allVoices = await j(await fetch(`${BASE}/voices`, { headers: H }));
for (const v of allVoices) {
  if (v.name.startsWith("测试音色")) await fetch(`${BASE}/voices/${v.id}`, { method: "DELETE", headers: H });
}
ok("cleanup done");

console.log(results.join("\n"));
console.log(`\n${results.filter((r) => r.startsWith("OK")).length} passed, ${results.filter((r) => r.startsWith("FAIL")).length} failed`);
