import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  intermediateJsonPath,
  taskDir,
  taskService,
  uploadedFilePath,
  uploadsDir,
  type IntermediateBody,
} from "./taskService";
import { buildAudioFileName, segmentContentHash } from "./audioFiles";

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

function writeIntermediate(id: number, body: IntermediateBody): void {
  fs.mkdirSync(taskDir(id), { recursive: true });
  fs.writeFileSync(intermediateJsonPath(id), JSON.stringify(body, null, 2), "utf8");
}

test("saveUpload replaces the previous uploaded document for the same task", () => {
  const id = taskService.create({ name: uniqueName("task-service-upload"), params_json: "{}" });

  try {
    const firstPath = taskService.saveUpload(id, "first.txt", Buffer.from("first upload", "utf8"));
    fs.writeFileSync(intermediateJsonPath(id), JSON.stringify({ text: "cached", sources: [], segments: {} }), "utf8");
    fs.writeFileSync(path.join(taskDir(id), "audio-001.wav"), "existing audio", "utf8");
    const secondPath = taskService.saveUpload(id, "second.txt", Buffer.from("second upload", "utf8"));

    assert.equal(fs.existsSync(firstPath), false);
    assert.equal(uploadedFilePath(id), secondPath);
    assert.deepEqual(fs.readdirSync(uploadsDir(id)).filter((name) => !name.startsWith(".")), ["second.txt"]);
    assert.equal(fs.readFileSync(secondPath, "utf8"), "second upload");
    assert.equal(fs.existsSync(intermediateJsonPath(id)), true);
    assert.equal(fs.existsSync(path.join(taskDir(id), "audio-001.wav")), true);
  } finally {
    if (fs.existsSync(taskDir(id))) {
      taskService.remove(id);
    }
  }
});

test("segmentKeys and audioKeys handle missing intermediate files and preserve segment insertion order", () => {
  const id = taskService.create({ name: uniqueName("task-service-segment-audio-keys"), params_json: "{}" });
  const body: IntermediateBody = {
    text: "part-b\npart-a",
    sources: ["正文"],
    segments: {
      "part-b": { text: "part-b", phonetic: "", source: "正文" },
      "part-a": { text: "part-a", phonetic: "", source: "正文" },
    },
  };

  try {
    assert.deepEqual(taskService.segmentKeys(id), []);
    assert.deepEqual([...taskService.audioKeys(id)], []);

    writeIntermediate(id, body);
    const segB = body.segments["part-b"];
    fs.writeFileSync(
      path.join(taskDir(id), buildAudioFileName("part-b", segmentContentHash(segB), "wav")),
      "ready",
      "utf8",
    );

    assert.deepEqual(taskService.segmentKeys(id), ["part-b", "part-a"]);
    assert.deepEqual([...taskService.audioKeys(id)], ["part-b"]);
  } finally {
    if (taskService.get(id)) {
      taskService.remove(id);
    } else if (fs.existsSync(taskDir(id))) {
      fs.rmSync(taskDir(id), { recursive: true, force: true });
    }
  }
});

test("migrateLegacyAudioNames 把 audio-<key>.<ext> 迁移为 <key>-<hash>.<ext> 并保留可用性", () => {
  const id = taskService.create({ name: uniqueName("task-service-migrate-audio"), params_json: "{}" });
  const body: IntermediateBody = {
    text: "第一段",
    sources: ["正文"],
    segments: { "001": { text: "第一段", phonetic: "", source: "正文" } },
  };

  try {
    writeIntermediate(id, body);
    fs.writeFileSync(path.join(taskDir(id), "audio-001.wav"), "legacy-audio", "utf8");
    assert.deepEqual([...taskService.audioKeys(id)], [], "旧命名不被识别");

    assert.equal(taskService.migrateLegacyAudioNames(id), 1);

    assert.equal(fs.existsSync(path.join(taskDir(id), "audio-001.wav")), false);
    assert.deepEqual([...taskService.audioKeys(id)], ["001"], "迁移后按内容 hash 可复用");
    assert.equal(taskService.segmentAudioPath(id, "001") !== null, true);
  } finally {
    if (taskService.get(id)) {
      taskService.remove(id);
    } else if (fs.existsSync(taskDir(id))) {
      fs.rmSync(taskDir(id), { recursive: true, force: true });
    }
  }
});

test("audioNameMap 只认当前内容 hash：同序号存在多个 hash 时不会命中旧音频", () => {
  const id = taskService.create({ name: uniqueName("task-service-audio-map"), params_json: "{}" });
  const body: IntermediateBody = {
    text: "第一段",
    sources: ["正文"],
    segments: { "001": { text: "第一段", phonetic: "", source: "正文" } },
  };

  try {
    writeIntermediate(id, body);
    const currentHash = segmentContentHash(body.segments["001"]);
    // 同序号、不同（历史）hash 的音频已存在
    fs.writeFileSync(
      path.join(taskDir(id), buildAudioFileName("001", "0".repeat(40), "wav")),
      "stale",
      "utf8",
    );
    assert.deepEqual(taskService.audioNameMap(id), {}, "旧 hash 不算命中");
    assert.equal(taskService.segmentAudioPath(id, "001"), null);

    fs.writeFileSync(
      path.join(taskDir(id), buildAudioFileName("001", currentHash, "wav")),
      "current",
      "utf8",
    );
    assert.equal(taskService.audioNameMap(id)["001"], `001-${currentHash}.wav`);
    assert.equal(taskService.segmentAudioPath(id, "001") !== null, true);
  } finally {
    if (taskService.get(id)) {
      taskService.remove(id);
    } else if (fs.existsSync(taskDir(id))) {
      fs.rmSync(taskDir(id), { recursive: true, force: true });
    }
  }
});

test("remove invalidates cached intermediate content for the same task id", () => {
  const id = taskService.create({ name: uniqueName("task-service-remove-cache"), params_json: "{}" });
  const pinnedTime = new Date("2024-01-02T03:04:05.000Z");
  const firstBody: IntermediateBody = {
    text: "old text",
    sources: ["old.txt"],
    segments: {
      "001": { text: "old text", phonetic: "", source: "old.txt" },
    },
  };
  const secondBody: IntermediateBody = {
    text: "new text",
    sources: ["new.txt"],
    segments: {
      "001": { text: "new text", phonetic: "", source: "new.txt" },
      "002": { text: "second segment", phonetic: "", source: "new.txt" },
    },
  };

  try {
    writeIntermediate(id, firstBody);
    fs.utimesSync(intermediateJsonPath(id), pinnedTime, pinnedTime);

    const firstStat = fs.statSync(intermediateJsonPath(id));
    assert.deepEqual(taskService.readIntermediate(id), firstBody);
    taskService.remove(id);

    writeIntermediate(id, secondBody);
    fs.utimesSync(intermediateJsonPath(id), firstStat.atime, firstStat.mtime);

    const recreatedStat = fs.statSync(intermediateJsonPath(id));
    assert.equal(recreatedStat.mtimeMs, firstStat.mtimeMs);

    assert.deepEqual(taskService.readIntermediate(id), secondBody);
  } finally {
    if (taskService.get(id)) {
      taskService.remove(id);
    } else if (fs.existsSync(taskDir(id))) {
      fs.rmSync(taskDir(id), { recursive: true, force: true });
    }
  }
});

test("clearIntermediate deletes the file and invalidates cached intermediate content", () => {
  const id = taskService.create({ name: uniqueName("task-service-clear-intermediate"), params_json: "{}" });
  const pinnedTime = new Date("2024-01-02T03:04:05.000Z");
  const firstBody: IntermediateBody = {
    text: "old text",
    sources: ["old.txt"],
    segments: {
      "001": { text: "old text", phonetic: "", source: "old.txt" },
    },
  };
  const secondBody: IntermediateBody = {
    text: "new text",
    sources: ["new.txt"],
    segments: {
      "001": { text: "new text", phonetic: "", source: "new.txt" },
    },
  };

  try {
    writeIntermediate(id, firstBody);
    fs.utimesSync(intermediateJsonPath(id), pinnedTime, pinnedTime);

    const firstStat = fs.statSync(intermediateJsonPath(id));
    assert.deepEqual(taskService.readIntermediate(id), firstBody);

    taskService.clearIntermediate(id);

    assert.equal(fs.existsSync(intermediateJsonPath(id)), false);
    assert.equal(taskService.readIntermediate(id), null);

    writeIntermediate(id, secondBody);
    fs.utimesSync(intermediateJsonPath(id), firstStat.atime, firstStat.mtime);

    const recreatedStat = fs.statSync(intermediateJsonPath(id));
    assert.equal(recreatedStat.mtimeMs, firstStat.mtimeMs);
    assert.deepEqual(taskService.readIntermediate(id), secondBody);
  } finally {
    if (taskService.get(id)) {
      taskService.remove(id);
    } else if (fs.existsSync(taskDir(id))) {
      fs.rmSync(taskDir(id), { recursive: true, force: true });
    }
  }
});