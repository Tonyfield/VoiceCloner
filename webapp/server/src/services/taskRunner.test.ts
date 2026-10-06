import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { modelService } from "./modelService";
import {
  allAudioReady,
  prepareTask,
  requestPause,
  requestStop,
  resumeTask,
  runTask,
  selectTtsKeys,
  synthesizeSegment,
  synthesizeTask,
  taskProgress,
} from "./taskRunner";
import {
  intermediateJsonPath,
  taskDir,
  taskService,
  type IntermediateBody,
  type TaskStatus,
} from "./taskService";
import { buildAudioFileName, segmentContentHash } from "./audioFiles";

const MINIMAL_MODEL_SCHEMA_YAML = [
  "label: Test model",
  "params: {}",
].join("\n");

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

function writeIntermediate(id: number, keys: string[]): IntermediateBody {
  const body: IntermediateBody = {
    text: keys.map((key) => `segment ${key}`).join("\n"),
    sources: ["正文"],
    segments: Object.fromEntries(
      keys.map((key) => [key, { text: `segment ${key}`, phonetic: "", source: "正文" }]),
    ),
  };

  fs.writeFileSync(intermediateJsonPath(id), JSON.stringify(body, null, 2), "utf8");
  return body;
}

/** 按新命名写一段“已存在”的音频：`<key>-<内容hash>.wav`。 */
function writeSegmentAudio(id: number, key: string, data = "existing-audio"): string {
  const seg = taskService.getSegment(id, key);
  assert.ok(seg, `segment ${key} missing`);
  const p = path.join(taskDir(id), buildAudioFileName(key, segmentContentHash(seg), "wav"));
  fs.writeFileSync(p, data, "utf8");
  return p;
}

/** 该分段是否已有内容匹配的音频。 */
function hasSegmentAudio(id: number, key: string): boolean {
  return taskService.segmentAudioPath(id, key) !== null;
}

function createTempModel(): number {
  return modelService.create({
    name: uniqueName("task-runner-model"),
    api_url: "http://127.0.0.1:59999",
    api_path: "/tts",
    api_key: "test-key",
    parameters_schema_yaml: MINIMAL_MODEL_SCHEMA_YAML,
  });
}

function expectCallable<T extends (...args: any[]) => unknown>(
  value: unknown,
  name: string,
): T {
  assert.equal(
    typeof value,
    "function",
    `${name} contract missing: taskRunner must export a callable ${name}`,
  );

  return value as T;
}

test("selectTtsKeys returns every segment key in document order when keys are omitted", () => {
  const body = {
    segments: {
      "001": { text: "第一段", phonetic: "" },
      "002": { text: "第二段", phonetic: "" },
      "003": { text: "第三段", phonetic: "" },
    },
  };

  const callableSelectTtsKeys = expectCallable<typeof selectTtsKeys>(
    selectTtsKeys,
    "selectTtsKeys",
  );

  assert.deepEqual(callableSelectTtsKeys(body), ["001", "002", "003"]);
});

test("selectTtsKeys reorders requested keys into document order and removes duplicates", () => {
  const body = {
    segments: {
      "001": { text: "第一段", phonetic: "" },
      "002": { text: "第二段", phonetic: "" },
      "003": { text: "第三段", phonetic: "" },
    },
  };

  const callableSelectTtsKeys = expectCallable<typeof selectTtsKeys>(
    selectTtsKeys,
    "selectTtsKeys",
  );

  assert.deepEqual(callableSelectTtsKeys(body, ["003", "001", "003"]), ["001", "003"]);
});

test("selectTtsKeys rejects unknown keys with the missing key in the error", () => {
  const body = {
    segments: {
      "001": { text: "第一段", phonetic: "" },
      "002": { text: "第二段", phonetic: "" },
    },
  };

  const callableSelectTtsKeys = expectCallable<typeof selectTtsKeys>(
    selectTtsKeys,
    "selectTtsKeys",
  );

  assert.throws(
    () => callableSelectTtsKeys(body, ["999"]),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("段落 999 不存在") &&
      error.message.includes("999"),
  );
});

test("allAudioReady is false when some selected segments still have no audio", () => {
  const callableAllAudioReady = expectCallable<typeof allAudioReady>(
    allAudioReady,
    "allAudioReady",
  );

  assert.equal(callableAllAudioReady(["001", "002"], new Set(["001"])), false);
});

test("allAudioReady is true when every selected segment already has audio", () => {
  const callableAllAudioReady = expectCallable<typeof allAudioReady>(
    allAudioReady,
    "allAudioReady",
  );

  assert.equal(callableAllAudioReady(["001", "002"], new Set(["001", "002"])), true);
});

test("taskProgress reports stable all-task audio coverage", () => {
  const callableTaskProgress = expectCallable<typeof taskProgress>(
    taskProgress,
    "taskProgress",
  );

  assert.equal(callableTaskProgress(["001", "002"], new Set(["001"])), 50);
  assert.equal(callableTaskProgress([], new Set()), 0);
  assert.equal(callableTaskProgress(["001", "002"], new Set(["001", "002"])), 100);
});

test("prepareTask records segmenting to ready lifecycle without calling TTS", async () => {
  const taskId = taskService.create({
    name: uniqueName("task-runner-prepare-success"),
    params_json: JSON.stringify({ segment_max_chars: 100, phonetic: false }),
  });
  const originalSetStatus = taskService.setStatus;
  const originalFetch = globalThis.fetch;
  const statusUpdates: Array<{
    status: TaskStatus;
    progress?: number;
    segment_count?: number;
  }> = [];
  let fetchCalls = 0;

  taskService.setStatus = ((id, status, extra) => {
    if (id === taskId) {
      statusUpdates.push({
        status,
        progress: extra?.progress,
        segment_count: extra?.segment_count,
      });
    }
    return originalSetStatus.call(taskService, id, status, extra);
  }) as typeof taskService.setStatus;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("prepareTask should not call TTS");
  };

  try {
    taskService.saveUpload(taskId, "document.txt", Buffer.from("第一段。\n\n第二段。", "utf8"));

    await prepareTask(taskId);

    assert.deepEqual(statusUpdates[0], {
      status: "segmenting",
      progress: 0,
      segment_count: 0,
    });

    const lastUpdate = statusUpdates[statusUpdates.length - 1];
    assert.equal(lastUpdate?.status, "ready");
    assert.equal(lastUpdate?.progress, 100);

    const task = taskService.get(taskId);
    assert.ok(task);
    assert.equal(task.status, "ready");
    assert.equal(task.progress, 100);
    assert.ok(task.segment_count > 0);

    const intermediate = taskService.readIntermediate(taskId);
    assert.ok(intermediate);
    assert.ok(Object.keys(intermediate.segments).length > 0);
    assert.equal(fetchCalls, 0);
  } finally {
    taskService.setStatus = originalSetStatus;
    globalThis.fetch = originalFetch;
    if (taskService.get(taskId)) {
      taskService.remove(taskId);
    } else if (fs.existsSync(taskDir(taskId))) {
      fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    }
  }
});

test("prepareTask marks the task as error when no upload exists", async () => {
  const taskId = taskService.create({
    name: uniqueName("task-runner-prepare-missing-upload"),
    params_json: JSON.stringify({ segment_max_chars: 100, phonetic: false }),
  });

  try {
    await assert.rejects(prepareTask(taskId), /任务没有上传文档/);

    const task = taskService.get(taskId);
    assert.ok(task);
    assert.equal(task.status, "error");
    assert.match(task.error || "", /任务没有上传文档/);
  } finally {
    if (taskService.get(taskId)) {
      taskService.remove(taskId);
    } else if (fs.existsSync(taskDir(taskId))) {
      fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    }
  }
});

test("prepareTask changes cleanup failures to error", async () => {
  const taskId = taskService.create({
    name: uniqueName("task-runner-prepare-cleanup-error"),
    params_json: JSON.stringify({ segment_max_chars: 100, phonetic: false }),
  });
  const originalClearIntermediate = taskService.clearIntermediate;

  taskService.clearIntermediate = ((id) => {
    if (id === taskId) {
      throw new Error("清理分段结果失败");
    }
    return originalClearIntermediate.call(taskService, id);
  }) as typeof taskService.clearIntermediate;

  try {
    taskService.saveUpload(taskId, "document.txt", Buffer.from("第一段。\n\n第二段。", "utf8"));

    await assert.rejects(prepareTask(taskId), /清理分段结果失败/);

    const task = taskService.get(taskId);
    assert.ok(task);
    assert.equal(task.status, "error");
    assert.match(task.error || "", /清理分段结果失败/);
  } finally {
    taskService.clearIntermediate = originalClearIntermediate;
    if (taskService.get(taskId)) {
      taskService.remove(taskId);
    } else if (fs.existsSync(taskDir(taskId))) {
      fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    }
  }
});

test("synthesizeTask reports running progress from all existing task audio coverage for partial selection", async () => {
  const modelId = createTempModel();
  const taskId = taskService.create({
    name: uniqueName("task-runner-partial-progress"),
    model_id: modelId,
    params_json: "{}",
  });
  const originalSetStatus = taskService.setStatus;
  const originalFetch = globalThis.fetch;
  const statusUpdates: Array<{ status: TaskStatus; progress?: number }> = [];

  writeIntermediate(taskId, ["001", "002", "003"]);
  writeSegmentAudio(taskId, "001");

  taskService.setStatus = ((id, status, extra) => {
    if (id === taskId) {
      statusUpdates.push({ status, progress: extra?.progress });
    }
    return originalSetStatus.call(taskService, id, status, extra);
  }) as typeof taskService.setStatus;

  globalThis.fetch = async () => new Response("test-audio", { status: 200 });

  try {
    await synthesizeTask(taskId, ["002"]);

    const runningProgress = statusUpdates
      .filter((entry) => entry.status === "running")
      .map((entry) => entry.progress);

    assert.deepEqual(runningProgress, [33, 67]);
    assert.deepEqual(statusUpdates[statusUpdates.length - 1], { status: "ready", progress: 67 });

    const task = taskService.get(taskId);
    assert.ok(task);
    assert.equal(task.status, "ready");
    assert.equal(task.progress, 67);
    assert.deepEqual([...taskService.audioKeys(taskId)], ["001", "002"]);
    assert.equal(hasSegmentAudio(taskId, "002"), true);
    assert.equal(hasSegmentAudio(taskId, "003"), false);
  } finally {
    taskService.setStatus = originalSetStatus;
    globalThis.fetch = originalFetch;
    taskService.remove(taskId);
    modelService.remove(modelId);
  }
});

test("synthesizeTask keeps skip_tts compatibility by finishing with done and no audio output", async () => {
  const taskId = taskService.create({
    name: uniqueName("task-runner-skip-tts"),
    params_json: "{}",
    skip_tts: true,
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  writeIntermediate(taskId, ["001", "002"]);
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("unexpected", { status: 200 });
  };

  try {
    await synthesizeTask(taskId);

    const task = taskService.get(taskId);
    assert.ok(task);
    assert.equal(task.status, "done");
    assert.equal(task.progress, 100);
    assert.equal(task.segment_count, 2);
    assert.deepEqual([...taskService.audioKeys(taskId)], []);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(taskService.listOutput(taskId), []);
  } finally {
    globalThis.fetch = originalFetch;
    taskService.remove(taskId);
  }
});

test("runTask completes a full non-skip_tts task with all audio outputs", async () => {
  const modelId = createTempModel();
  const taskId = taskService.create({
    name: uniqueName("task-runner-full-run"),
    model_id: modelId,
    params_json: "{}",
  });
  const originalSetStatus = taskService.setStatus;
  const originalFetch = globalThis.fetch;

  writeIntermediate(taskId, ["001", "002"]);
  globalThis.fetch = async () => new Response("test-audio", { status: 200 });

  try {
    await runTask(taskId);

    const task = taskService.get(taskId);
    assert.ok(task);
    assert.equal(task.status, "done");
    assert.equal(task.progress, 100);
    assert.deepEqual([...taskService.audioKeys(taskId)], ["001", "002"]);
    assert.equal(hasSegmentAudio(taskId, "001"), true);
    assert.equal(hasSegmentAudio(taskId, "002"), true);
  } finally {
    taskService.setStatus = originalSetStatus;
    globalThis.fetch = originalFetch;
    if (taskService.get(taskId)) {
      taskService.remove(taskId);
    } else if (fs.existsSync(taskDir(taskId))) {
      fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    }
    if (modelService.get(modelId)) {
      modelService.remove(modelId);
    }
  }
});

test("synthesizeTask rejects only while the task is segmenting", async () => {
  const originalSetStatus = taskService.setStatus;
  const originalFetch = globalThis.fetch;
  const taskId = taskService.create({
    name: uniqueName("task-runner-busy-segmenting"),
    params_json: "{}",
  });

  try {
    writeIntermediate(taskId, ["001"]);
    taskService.setStatus(taskId, "segmenting", { progress: 0, error: null, segment_count: 1 });

    await assert.rejects(
      synthesizeTask(taskId),
      (error: unknown) => error instanceof Error && error.message.includes("任务正在分段中"),
    );
  } finally {
    taskService.setStatus = originalSetStatus;
    globalThis.fetch = originalFetch;
    if (taskService.get(taskId)) {
      taskService.remove(taskId);
    } else if (fs.existsSync(taskDir(taskId))) {
      fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    }
  }
});

test("synthesis requests are queued and interleaved round-robin across sub-queues", async () => {
  const modelId = createTempModel();
  const taskId = taskService.create({
    name: uniqueName("task-runner-queue"),
    model_id: modelId,
    params_json: JSON.stringify({}),
  });
  const originalFetch = globalThis.fetch;
  const order: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let blocked = true;

  writeIntermediate(taskId, ["001", "002", "003", "004"]);
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const match = /segment (\S+)/.exec(String(body.input ?? ""));
    order.push(match ? match[1] : String(body.input ?? ""));
    if (blocked) {
      blocked = false;
      await gate;
    }
    return new Response("test-audio", { status: 200 });
  };

  try {
    const runA = synthesizeTask(taskId, ["001", "002"]);
    for (let i = 0; i < 200 && order.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(order, ["001"]);

    // 第一段运行中再入队 B、C（不再被拒绝）
    const runB = synthesizeTask(taskId, ["003"]);
    const runC = synthesizeTask(taskId, ["004"]);
    releaseFirst();
    await Promise.all([runA, runB, runC]);

    // A(001,002) B(003) C(004)：轮转顺序 A1,B1,C1,A2
    assert.deepEqual(order, ["001", "003", "004", "002"]);
    assert.equal(taskService.get(taskId)?.status, "done");
  } finally {
    globalThis.fetch = originalFetch;
    if (taskService.get(taskId)) {
      taskService.remove(taskId);
    } else if (fs.existsSync(taskDir(taskId))) {
      fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    }
    if (modelService.get(modelId)) {
      modelService.remove(modelId);
    }
  }
});

test("synthesizeTask keeps already-generated audio when a later TTS request fails", async () => {
  const modelId = createTempModel();
  const taskId = taskService.create({
    name: uniqueName("task-runner-partial-failure"),
    model_id: modelId,
    params_json: "{}",
  });
  const originalSetStatus = taskService.setStatus;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  writeIntermediate(taskId, ["001", "002", "003"]);
  writeSegmentAudio(taskId, "001");
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return new Response("test-audio", { status: 200 });
    throw new Error("mocked fetch failure");
  };

  try {
    await assert.rejects(synthesizeTask(taskId, ["002", "003"]));

    const task = taskService.get(taskId);
    assert.ok(task);
    assert.equal(task.status, "error");
    assert.equal(hasSegmentAudio(taskId, "001"), true);
    assert.equal(hasSegmentAudio(taskId, "002"), true);
    assert.equal(hasSegmentAudio(taskId, "003"), false);
  } finally {
    taskService.setStatus = originalSetStatus;
    globalThis.fetch = originalFetch;
    if (taskService.get(taskId)) {
      taskService.remove(taskId);
    } else if (fs.existsSync(taskDir(taskId))) {
      fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    }
    if (modelService.get(modelId)) {
      modelService.remove(modelId);
    }
  }
});

test("synthesizeSegment sends the expected request payload and writes <key>-<hash>.wav", async () => {
  const modelName = uniqueName("task-runner-segment-model");
  const modelId = modelService.create({
    name: modelName,
    api_url: "http://tts.test",
    api_path: "/v1/audio/speech",
    api_key: "model-key",
    parameters_schema_yaml: MINIMAL_MODEL_SCHEMA_YAML,
  });
  const taskId = taskService.create({
    name: uniqueName("task-runner-synthesize-segment"),
    model_id: modelId,
    params_json: JSON.stringify({
      api_key: "request-key",
      custom_option: "custom-value",
      // 程序侧文本增强开关：不得作为 TTS 参数发送
      interjection_prefix_enabled: true,
      interjection_prefix: "-",
      word_gap_enabled: true,
      word_gap: "-",
      punct_comma_enabled: false,
      text_rules: [{ pattern: "[。]", position: "after", insert: "\n" }],
      epub_start: 1,
      epub_end: 5,
    }),
  });
  const originalSetStatus = taskService.setStatus;
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders: Headers | Record<string, string> | undefined;
  let capturedBody = "";

  writeIntermediate(taskId, ["001"]);
  globalThis.fetch = async (input: unknown, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = init?.headers instanceof Headers
      ? init.headers
      : (init?.headers as Record<string, string> | undefined);
    capturedBody = typeof init?.body === "string" ? init.body : "";
    return new Response("test-audio", { status: 200 });
  };

  try {
    await synthesizeSegment(taskId, "001");

    const task = taskService.get(taskId);
    assert.ok(task);
    assert.equal(task.status, "done");
    assert.equal(task.progress, 100);
    assert.equal(hasSegmentAudio(taskId, "001"), true);
    assert.equal(capturedUrl, "http://tts.test/v1/audio/speech");

    const authorization = capturedHeaders instanceof Headers
      ? capturedHeaders.get("Authorization")
      : capturedHeaders?.Authorization;
    // 模型配置的 API Key 优先；任务内遗留的 api_key 不得覆盖（曾导致 401）
    assert.equal(authorization, "Bearer model-key");

    const payload = JSON.parse(capturedBody) as Record<string, unknown>;
    assert.equal(payload.input, "segment 001");
    assert.equal(payload.model, modelName);
    // 自定义参数仍然按 extra_params 透传；程序内部开关不得出现在 payload 的任何位置
    assert.deepEqual(payload.extra_params, { custom_option: "custom-value" });
    assert.equal("api_key" in payload, false);
    const serialized = JSON.stringify(payload);
    for (const internalKey of [
      "interjection_prefix_enabled",
      "interjection_prefix",
      "word_gap_enabled",
      "word_gap",
      "punct_comma_enabled",
      "text_rules",
      "epub_start",
      "epub_end",
    ]) {
      assert.equal(serialized.includes(internalKey), false, `不应发送 ${internalKey}`);
    }
  } finally {
    taskService.setStatus = originalSetStatus;
    globalThis.fetch = originalFetch;
    if (taskService.get(taskId)) {
      taskService.remove(taskId);
    } else if (fs.existsSync(taskDir(taskId))) {
      fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    }
    if (modelService.get(modelId)) {
      modelService.remove(modelId);
    }
  }
});

test("requestStop aborts a running synthesis and leaves the task ready", async () => {
  const modelId = createTempModel();
  const taskId = taskService.create({
    name: uniqueName("task-runner-stop"),
    model_id: modelId,
    params_json: JSON.stringify({}),
  });
  const originalFetch = globalThis.fetch;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  writeIntermediate(taskId, ["001", "002"]);
  globalThis.fetch = (_input: unknown, init?: RequestInit) => {
    markStarted();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };

  try {
    const run = synthesizeTask(taskId);
    await started;
    requestStop(taskId);
    await assert.rejects(run, /已停止/);

    const task = taskService.get(taskId);
    assert.ok(task);
    assert.equal(task.status, "ready");
    assert.equal(hasSegmentAudio(taskId, "001"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (taskService.get(taskId)) {
      taskService.remove(taskId);
    } else if (fs.existsSync(taskDir(taskId))) {
      fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    }
    if (modelService.get(modelId)) {
      modelService.remove(modelId);
    }
  }
});

test("requestPause pauses a running synthesis and resumeTask finishes the rest", async () => {
  const modelId = createTempModel();
  const taskId = taskService.create({
    name: uniqueName("task-runner-pause"),
    model_id: modelId,
    params_json: JSON.stringify({}),
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });

  writeIntermediate(taskId, ["001", "002"]);
  globalThis.fetch = (_input: unknown, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) return Promise.resolve(new Response("test-audio", { status: 200 }));
    markSecondStarted();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };

  try {
    const run = synthesizeTask(taskId);
    await secondStarted;
    requestPause(taskId);
    await assert.rejects(run, /已暂停/);

    const paused = taskService.get(taskId);
    assert.ok(paused);
    assert.equal(paused.status, "paused");
    assert.equal(hasSegmentAudio(taskId, "001"), true);
    assert.equal(hasSegmentAudio(taskId, "002"), false);

    globalThis.fetch = async () => new Response("test-audio", { status: 200 });
    await resumeTask(taskId);

    const done = taskService.get(taskId);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.equal(hasSegmentAudio(taskId, "002"), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (taskService.get(taskId)) {
      taskService.remove(taskId);
    } else if (fs.existsSync(taskDir(taskId))) {
      fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    }
    if (modelService.get(modelId)) {
      modelService.remove(modelId);
    }
  }
});

test("relinkAudioByContent 按内容 hash 把旧序号的音频对齐到新序号", () => {
  const taskId = taskService.create({
    name: uniqueName("task-runner-relink-audio"),
    params_json: "{}",
  });

  try {
    writeIntermediate(taskId, ["001", "002"]);
    const seg = taskService.getSegment(taskId, "001");
    assert.ok(seg);
    // 旧音频用了别的分段序号，但内容 hash 相同
    fs.writeFileSync(
      path.join(taskDir(taskId), buildAudioFileName("099", segmentContentHash(seg), "wav")),
      "old-audio",
      "utf8",
    );
    assert.deepEqual([...taskService.audioKeys(taskId)], []);

    assert.equal(taskService.relinkAudioByContent(taskId), 1);
    assert.deepEqual([...taskService.audioKeys(taskId)], ["001"]);
    assert.equal(hasSegmentAudio(taskId, "001"), true);
  } finally {
    if (taskService.get(taskId)) taskService.remove(taskId);
    else if (fs.existsSync(taskDir(taskId))) fs.rmSync(taskDir(taskId), { recursive: true, force: true });
  }
});

test("synthesizeTask 带 skipExisting 时跳过已有音频的分段", async () => {
  const modelId = createTempModel();
  const taskId = taskService.create({
    name: uniqueName("task-runner-skip-existing"),
    model_id: modelId,
    params_json: "{}",
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    writeIntermediate(taskId, ["001", "002"]);
    writeSegmentAudio(taskId, "001"); // 001 已有内容匹配的音频
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("test-audio", { status: 200 });
    };

    await synthesizeTask(taskId, undefined, { skipExisting: true });

    assert.equal(fetchCalls, 1, "只应为缺音频的 002 发起合成");
    assert.equal(hasSegmentAudio(taskId, "001"), true);
    assert.equal(hasSegmentAudio(taskId, "002"), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (taskService.get(taskId)) taskService.remove(taskId);
    else if (fs.existsSync(taskDir(taskId))) fs.rmSync(taskDir(taskId), { recursive: true, force: true });
    if (modelService.get(modelId)) modelService.remove(modelId);
  }
});