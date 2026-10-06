import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import { createApp } from "../app";
import { initDatabase } from "../db/database";
import { xmlize } from "../services/phonetic";
import { taskDir, taskService } from "../services/taskService";
import { buildAudioFileName, segmentContentHash } from "../services/audioFiles";

const createdTaskIds = new Set<number>();
const createdModelIds = new Set<number>();
const createdDirs = new Set<string>();

let server: http.Server;
let baseUrl = "";

const immediateStatuses = new Set(["segmenting", "error", "ready"]);

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

function rememberTask(id: number): number {
  createdTaskIds.add(id);
  createdDirs.add(taskDir(id));
  return id;
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function api(path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await readJson(response) };
}

async function waitForTaskStatus(id: number, expectedStatus: string, timeoutMs = 8000): Promise<any> {
  const startedAt = Date.now();
  let lastBody: any = null;
  let lastStatus = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const { response, body } = await api(`/api/tasks/${id}`);
    lastStatus = response.status;
    lastBody = body;
    if (response.ok && body?.status === expectedStatus) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `Timed out waiting for task ${id} to reach status ${expectedStatus}. ` +
      `Last HTTP ${lastStatus} body: ${JSON.stringify(lastBody)}`,
  );
}

async function createReadySkipTtsTask(prefix: string, text: string): Promise<{ id: number; key: string }> {
  const id = rememberTask(
    taskService.create({
      name: uniqueName(prefix),
      params_json: JSON.stringify({ phonetic: false }),
      skip_tts: true,
    }),
  );
  taskService.saveUpload(id, "source.txt", Buffer.from(text, "utf8"));

  const { response, body } = await api(`/api/tasks/${id}/prepare`, { method: "POST" });
  assert.equal(response.status, 202, JSON.stringify(body));
  assert.equal(body?.ok, true);

  await waitForTaskStatus(id, "ready");

  const segmentsResult = await api(`/api/tasks/${id}/segments`);
  assert.equal(segmentsResult.response.status, 200, JSON.stringify(segmentsResult.body));
  const key = segmentsResult.body?.segments?.[0]?.key;
  assert.equal(typeof key, "string", JSON.stringify(segmentsResult.body));
  return { id, key };
}

before(async () => {
  initDatabase();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start HTTP test server");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  for (const id of createdTaskIds) {
    if (taskService.get(id)) {
      taskService.remove(id);
    }
  }

  for (const dir of createdDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("创建任务后立即 GET 详情与 info 均不是 idle 并最终 ready", async () => {
  const name = uniqueName("route-create-segmenting");
  const form = new FormData();
  form.append("name", name);
  form.append("skip_tts", "true");
  form.append("file", new Blob(["第一段。\n\n第二段。"], { type: "text/plain" }), "source.txt");

  const { response, body } = await api("/api/tasks", { method: "POST", body: form });
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(typeof body?.id, "number", JSON.stringify(body));
  rememberTask(body.id);
  assert.equal(body?.name, name);
  assert.equal(body?.status, "segmenting", JSON.stringify(body));

  const taskResult = await api(`/api/tasks/${body.id}`);
  assert.equal(taskResult.response.status, 200, JSON.stringify(taskResult.body));
  assert.notEqual(taskResult.body?.status, "idle", JSON.stringify(taskResult.body));
  assert.equal(immediateStatuses.has(taskResult.body?.status), true, JSON.stringify(taskResult.body));

  const infoResult = await api(`/api/tasks/${body.id}/info`);
  assert.equal(infoResult.response.status, 200, JSON.stringify(infoResult.body));
  assert.notEqual(infoResult.body?.status, "idle", JSON.stringify(infoResult.body));
  assert.equal(immediateStatuses.has(infoResult.body?.status), true, JSON.stringify(infoResult.body));

  const task = await waitForTaskStatus(body.id, "ready");
  assert.equal(task.status, "ready");

  const readyInfoResult = await api(`/api/tasks/${body.id}/info`);
  assert.notEqual(readyInfoResult.response.status, 404, JSON.stringify(readyInfoResult.body));
  assert.equal(readyInfoResult.body?.status, "ready");
  assert.equal(typeof readyInfoResult.body?.progress, "number");
  assert.equal(readyInfoResult.body?.error, null);
  assert.equal(typeof readyInfoResult.body?.text, "string");
  assert.ok(Array.isArray(readyInfoResult.body?.sources));
  assert.ok(readyInfoResult.body?.segmentCount > 0, JSON.stringify(readyInfoResult.body));

  const readyTaskResult = await api(`/api/tasks/${body.id}`);
  assert.equal(readyTaskResult.response.status, 200, JSON.stringify(readyTaskResult.body));
  assert.ok(
    Array.isArray(readyTaskResult.body?.files) &&
      readyTaskResult.body.files.every((file: string) => !file.startsWith("audio-")),
    JSON.stringify(readyTaskResult.body),
  );
});

test("无上传创建任务仍返回 201 并最终标记为 error", async () => {
  const form = new FormData();
  form.append("name", uniqueName("route-create-without-upload"));
  form.append("skip_tts", "true");

  const { response, body } = await api("/api/tasks", { method: "POST", body: form });
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(typeof body?.id, "number", JSON.stringify(body));
  assert.equal(typeof body?.status, "string", JSON.stringify(body));
  rememberTask(body.id);

  const task = await waitForTaskStatus(body.id, "error");
  assert.equal(task.status, "error");
  assert.match(task.error || "", /任务没有上传文档/);
});

test("无 intermediate 的 info 返回状态而不是 404", async () => {
  const id = rememberTask(
    taskService.create({
      name: uniqueName("route-info-no-intermediate"),
      params_json: "{}",
    }),
  );

  const task = taskService.get(id);
  assert.ok(task);

  const { response, body } = await api(`/api/tasks/${id}/info`);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body?.status, task.status);
  assert.equal(body?.segmentCount, 0);
  assert.equal(body?.text, "");
  assert.deepEqual(body?.sources, []);
});

test("准备路由可重试并最终 ready", async () => {
  const id = rememberTask(
    taskService.create({
      name: uniqueName("route-prepare"),
      params_json: JSON.stringify({ phonetic: false }),
      skip_tts: true,
    }),
  );
  taskService.saveUpload(id, "source.txt", Buffer.from("堂吉诃德出发。", "utf8"));

  const { response, body } = await api(`/api/tasks/${id}/prepare`, { method: "POST" });
  assert.equal(response.status, 202, JSON.stringify(body));
  assert.equal(body?.ok, true);

  const task = await waitForTaskStatus(id, "ready");
  assert.equal(task.status, "ready");

  const firstKey = taskService.segmentKeys(id)[0];
  const firstSeg = taskService.getSegment(id, firstKey);
  assert.ok(firstSeg);
  const staleAudio = path.join(taskDir(id), buildAudioFileName(firstKey, segmentContentHash(firstSeg), "wav"));
  fs.writeFileSync(staleAudio, Buffer.from("stale-audio", "utf8"));
  taskService.saveUpload(id, "source.txt", Buffer.from("新的内容，重新准备。", "utf8"));

  const retry = await api(`/api/tasks/${id}/prepare`, { method: "POST" });
  assert.equal(retry.response.status, 202, JSON.stringify(retry.body));
  assert.equal(retry.body?.ok, true);

  const retriedTask = await waitForTaskStatus(id, "ready");
  assert.equal(retriedTask.status, "ready");

  // 重新分段不再删除音频文件；旧音频保留在磁盘上，但内容已不匹配新分段。
  assert.equal(fs.existsSync(staleAudio), true, "重新分段不应删除旧音频");
  assert.deepEqual([...taskService.audioKeys(id)], [], "新分段没有内容匹配的音频");
});

test("multipart 更新 skip_tts 字符串 false/true 被明确解析", async () => {
  const createForm = new FormData();
  createForm.append("name", uniqueName("route-update-skip-tts"));
  createForm.append("skip_tts", "true");
  createForm.append("file", new Blob(["第一段。\n\n第二段。"], { type: "text/plain" }), "source.txt");

  const created = await api("/api/tasks", { method: "POST", body: createForm });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(typeof created.body?.id, "number", JSON.stringify(created.body));
  const id = rememberTask(created.body.id);

  await waitForTaskStatus(id, "ready");
  assert.equal(taskService.get(id)?.skip_tts, 1);

  const falseForm = new FormData();
  falseForm.append("skip_tts", "false");
  falseForm.append("file", new Blob(["更新后的正文。"], { type: "text/plain" }), "updated.txt");

  const falseUpdate = await api(`/api/tasks/${id}`, { method: "PUT", body: falseForm });
  assert.equal(falseUpdate.response.status, 200, JSON.stringify(falseUpdate.body));
  assert.equal(taskService.get(id)?.skip_tts, 0);

  const trueForm = new FormData();
  trueForm.append("skip_tts", "true");

  const trueUpdate = await api(`/api/tasks/${id}`, { method: "PUT", body: trueForm });
  assert.equal(trueUpdate.response.status, 200, JSON.stringify(trueUpdate.body));
  assert.equal(taskService.get(id)?.skip_tts, 1);
});

test("并发 prepare 请求中恰好一个返回 202 且最终 ready", async () => {
  const id = rememberTask(
    taskService.create({
      name: uniqueName("route-prepare-concurrent"),
      params_json: JSON.stringify({ phonetic: false }),
      skip_tts: true,
    }),
  );

  try {
    taskService.saveUpload(id, "source.txt", Buffer.from("第一段。\n\n第二段。", "utf8"));

    const [first, second] = await Promise.all([
      api(`/api/tasks/${id}/prepare`, { method: "POST" }),
      api(`/api/tasks/${id}/prepare`, { method: "POST" }),
    ]);

    const task = await waitForTaskStatus(id, "ready");
    assert.equal(task.status, "ready");

    const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
    assert.deepEqual(
      statuses,
      [202, 409],
      JSON.stringify({
        statuses,
        first: first.body,
        second: second.body,
      }),
    );
  } finally {
    if (taskService.get(id)) {
      taskService.remove(id);
    }
  }
});

test("重新上传不支持格式后 prepare 失败时旧 intermediate 不再可被消费", async () => {
  const id = rememberTask(
    taskService.create({
      name: uniqueName("route-stale-intermediate"),
      params_json: JSON.stringify({ phonetic: false }),
      skip_tts: true,
    }),
  );

  try {
    taskService.saveUpload(id, "source.txt", Buffer.from("堂吉诃德出发。", "utf8"));

    const firstPrepare = await api(`/api/tasks/${id}/prepare`, { method: "POST" });
    assert.equal(firstPrepare.response.status, 202, JSON.stringify(firstPrepare.body));
    assert.equal(firstPrepare.body?.ok, true);

    await waitForTaskStatus(id, "ready");

    const intermediate = taskService.readIntermediate(id);
    assert.ok(intermediate);
    assert.ok(Object.keys(intermediate.segments).length > 0, JSON.stringify(intermediate));

    taskService.saveUpload(id, "broken.unsupported", Buffer.from("not supported", "utf8"));

    const secondPrepare = await api(`/api/tasks/${id}/prepare`, { method: "POST" });
    assert.equal(secondPrepare.response.status, 202, JSON.stringify(secondPrepare.body));
    assert.equal(secondPrepare.body?.ok, true);

    const erroredTask = await waitForTaskStatus(id, "error");
    assert.equal(erroredTask.status, "error");

    const runAfterError = await api(`/api/tasks/${id}/run`, { method: "POST" });
    assert.equal(runAfterError.response.status, 409, JSON.stringify(runAfterError.body));

    const ttsAfterError = await api(`/api/tasks/${id}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(ttsAfterError.response.status, 409, JSON.stringify(ttsAfterError.body));

    const infoAfterError = await api(`/api/tasks/${id}/info`);
    assert.equal(infoAfterError.response.status, 200, JSON.stringify(infoAfterError.body));
    assert.equal(infoAfterError.body?.segmentCount, 0, JSON.stringify(infoAfterError.body));
    assert.equal(infoAfterError.body?.text, "", JSON.stringify(infoAfterError.body));

    const segmentsAfterError = await api(`/api/tasks/${id}/segments`);
    assert.equal(segmentsAfterError.response.status, 404, JSON.stringify(segmentsAfterError.body));
  } finally {
    if (taskService.get(id)) {
      taskService.remove(id);
    }
  }
});

test("准备未知任务返回 404", async () => {
  const { response, body } = await api("/api/tasks/999999/prepare", { method: "POST" });
  assert.equal(response.status, 404, JSON.stringify(body));
  assert.match(body?.error || "", /任务不存在/);
});

test("运行未知任务返回 404", async () => {
  const { response, body } = await api("/api/tasks/999999/run", { method: "POST" });
  assert.equal(response.status, 404, JSON.stringify(body));
  assert.match(body?.error || "", /任务不存在/);
});

test("无 intermediate 的 run 与 tts 返回 409 且不启动后台任务", async () => {
  const id = rememberTask(
    taskService.create({
      name: uniqueName("route-no-intermediate"),
      params_json: JSON.stringify({ phonetic: false }),
      skip_tts: true,
    }),
  );

  const runStart = await api(`/api/tasks/${id}/run`, { method: "POST" });
  assert.equal(runStart.response.status, 409, JSON.stringify(runStart.body));

  const ttsStart = await api(`/api/tasks/${id}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: ["001"] }),
  });
  assert.equal(ttsStart.response.status, 409, JSON.stringify(ttsStart.body));

  await Promise.resolve();
  assert.equal(taskService.get(id)?.status, "idle");
});

test("busy 状态的 prepare 与 run 返回 409 且不启动后台任务", async () => {
  const runningId = rememberTask(
    taskService.create({
      name: uniqueName("route-running"),
      params_json: JSON.stringify({ phonetic: false }),
      skip_tts: true,
    }),
  );
  taskService.setStatus(runningId, "running", { progress: 42, error: null });

  const prepareStart = await api(`/api/tasks/${runningId}/prepare`, { method: "POST" });
  assert.equal(prepareStart.response.status, 409, JSON.stringify(prepareStart.body));
  await Promise.resolve();
  assert.equal(taskService.get(runningId)?.status, "running");

  const segmentingId = rememberTask(
    taskService.create({
      name: uniqueName("route-segmenting"),
      params_json: JSON.stringify({ phonetic: false }),
      skip_tts: true,
    }),
  );
  taskService.setStatus(segmentingId, "segmenting", { progress: 5, error: null });

  const runStart = await api(`/api/tasks/${segmentingId}/run`, { method: "POST" });
  assert.equal(runStart.response.status, 409, JSON.stringify(runStart.body));
  await Promise.resolve();
  assert.equal(taskService.get(segmentingId)?.status, "segmenting");
});

test("批量 TTS 的未知任务返回 404", async () => {
  const { response, body } = await api("/api/tasks/999999/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: ["001"] }),
  });
  assert.equal(response.status, 404, JSON.stringify(body));
  assert.match(body?.error || "", /任务不存在/);
});

test("按段自动注音路由返回 xmlize 结果并校验参数", async () => {
  const readyTask = await createReadySkipTtsTask("route-auto-phonetic", "堂吉诃德大战风车。");

  // 注音结果与 jieba 的分词边界一致：用「行长」这类既被 jieba 切成一个词、
  // 又存在于 CC-CEDICT 的词，才会产生 <phoneme> 标记。
  const success = await api(`/api/tasks/${readyTask.id}/segments/${readyTask.key}/auto-phonetic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "行长" }),
  });
  assert.equal(success.response.status, 200, JSON.stringify(success.body));
  assert.equal(success.body?.text, "行长");
  assert.equal(success.body?.phonetic, xmlize("行长"));
  assert.match(success.body?.phonetic || "", /phoneme/);
  assert.match(success.body?.phonetic || "", /行长/);

  const badText = await api(`/api/tasks/${readyTask.id}/segments/${readyTask.key}/auto-phonetic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: 123 }),
  });
  assert.equal(badText.response.status, 400, JSON.stringify(badText.body));

  const missingKey = await api(`/api/tasks/${readyTask.id}/segments/999/auto-phonetic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "堂吉诃德" }),
  });
  assert.equal(missingKey.response.status, 404, JSON.stringify(missingKey.body));
});

test("原文搜索支持大小写敏感、通配符与参数校验", async () => {
  const readyTask = await createReadySkipTtsTask("route-search", "Alpha beta gamma");

  const insensitive = await api(`/api/tasks/${readyTask.id}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "alpha" }),
  });
  assert.equal(insensitive.response.status, 200, JSON.stringify(insensitive.body));
  assert.equal(insensitive.body.total, 1);

  const sensitive = await api(`/api/tasks/${readyTask.id}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "alpha", caseSensitive: true }),
  });
  assert.equal(sensitive.response.status, 200, JSON.stringify(sensitive.body));
  assert.equal(sensitive.body.total, 0);

  const regex = await api(`/api/tasks/${readyTask.id}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "^Alpha b.*a$", wildcard: true }),
  });
  assert.equal(regex.response.status, 200, JSON.stringify(regex.body));
  assert.equal(regex.body.total, 1);

  const invalid = await api(`/api/tasks/${readyTask.id}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "[", wildcard: true }),
  });
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.body));

  const empty = await api(`/api/tasks/${readyTask.id}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "" }),
  });
  assert.equal(empty.response.status, 400, JSON.stringify(empty.body));
});

test("批量 TTS 和 run 路由异步启动且最终 done", async () => {
  const ttsTask = await createReadySkipTtsTask("route-tts", "第一段。\n第二段。");

  const ttsStart = await api(`/api/tasks/${ttsTask.id}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: [ttsTask.key] }),
  });
  assert.equal(ttsStart.response.status, 202, JSON.stringify(ttsStart.body));
  assert.equal(ttsStart.body?.ok, true);
  assert.match(ttsStart.body?.message || "", /语音合成/);

  const badKeys = await api(`/api/tasks/${ttsTask.id}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: "bad" }),
  });
  assert.equal(badKeys.response.status, 400, JSON.stringify(badKeys.body));

  await waitForTaskStatus(ttsTask.id, "done");

  const runTaskReady = await createReadySkipTtsTask("route-run", "第三段。\n第四段。");
  const runStart = await api(`/api/tasks/${runTaskReady.id}/run`, { method: "POST" });
  assert.equal(runStart.response.status, 202, JSON.stringify(runStart.body));
  assert.equal(runStart.body?.ok, true);
  assert.match(runStart.body?.message || "", /语音合成/);

  const finalTask = await waitForTaskStatus(runTaskReady.id, "done");
  assert.equal(finalTask.status, "done");
});

test("批量 TTS 对空 keys 与未知 keys 返回 400 且不启动后台任务", async () => {
  const ttsTask = await createReadySkipTtsTask("route-tts-invalid-keys", "第一段。\n第二段。");

  const emptyKeys = await api(`/api/tasks/${ttsTask.id}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: [] }),
  });
  assert.equal(emptyKeys.response.status, 400, JSON.stringify(emptyKeys.body));

  const unknownKeys = await api(`/api/tasks/${ttsTask.id}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: ["999"] }),
  });
  assert.equal(unknownKeys.response.status, 400, JSON.stringify(unknownKeys.body));

  await Promise.resolve();
  assert.equal(taskService.get(ttsTask.id)?.status, "ready");
});

test("分段标记与步骤记录接口：PUT mark / GET marks / GET steps / 按标记搜索", async () => {
  const id = rememberTask(
    taskService.create({
      name: uniqueName("route-segment-marks"),
      // 分段长度设小，保证三行拆成多段
      params_json: JSON.stringify({ phonetic: false, segment_max_chars: 4 }),
      skip_tts: true,
    }),
  );
  taskService.saveUpload(id, "source.txt", Buffer.from("第一段。\n\n第二段。\n\n第三段。", "utf8"));

  const prepared = await api(`/api/tasks/${id}/prepare`, { method: "POST" });
  assert.equal(prepared.response.status, 202, JSON.stringify(prepared.body));
  await waitForTaskStatus(id, "ready");

  const keys = taskService.segmentKeys(id);
  assert.ok(keys.length >= 2, `期望至少 2 段，实际 ${keys.join(",")}`);
  const [firstKey, secondKey] = keys;

  // 点赞（无反馈）
  const like = await api(`/api/tasks/${id}/segments/${secondKey}/mark`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mark: "like" }),
  });
  assert.equal(like.response.status, 200, JSON.stringify(like.body));
  assert.equal(like.body?.marks?.[secondKey]?.mark, "like");

  // 点踩且不填反馈（反馈为空字符串）
  const dislike = await api(`/api/tasks/${id}/segments/${firstKey}/mark`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mark: "dislike" }),
  });
  assert.equal(dislike.response.status, 200, JSON.stringify(dislike.body));
  assert.equal(dislike.body?.marks?.[firstKey]?.mark, "dislike");
  assert.equal(dislike.body?.marks?.[firstKey]?.feedback, "");

  // 点踩并附反馈
  const dislikeWithText = await api(`/api/tasks/${id}/segments/${firstKey}/mark`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mark: "dislike", feedback: "断句不对" }),
  });
  assert.equal(dislikeWithText.response.status, 200, JSON.stringify(dislikeWithText.body));
  assert.equal(dislikeWithText.body?.marks?.[firstKey]?.feedback, "断句不对");

  // 取消标记
  const cleared = await api(`/api/tasks/${id}/segments/${secondKey}/mark`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mark: null }),
  });
  assert.equal(cleared.response.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body?.marks?.[secondKey], undefined);

  // GET marks
  const marksRes = await api(`/api/tasks/${id}/marks`);
  assert.equal(marksRes.response.status, 200, JSON.stringify(marksRes.body));
  assert.equal(marksRes.body?.marks?.[firstKey]?.mark, "dislike");

  // 步骤记录：prepare 时应已写入「分段」步骤（含时间与长度）
  const steps = await api(`/api/tasks/${id}/segments/${firstKey}/steps`);
  assert.equal(steps.response.status, 200, JSON.stringify(steps.body));
  const segmentStep = (steps.body?.steps ?? []).find((s: any) => s.step === "segment");
  assert.ok(segmentStep, JSON.stringify(steps.body));
  assert.ok(segmentStep.created_at, "步骤应记录时间");
  assert.equal(typeof segmentStep.detail?.length, "number");

  // 按标记类型搜索（query 可为空）
  const search = await api(`/api/tasks/${id}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "", mark: "dislike" }),
  });
  assert.equal(search.response.status, 200, JSON.stringify(search.body));
  assert.deepEqual(
    (search.body?.results ?? []).map((r: any) => r.key),
    [firstKey],
  );
});