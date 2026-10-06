import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { buildAudioFileName, segmentContentHash } from "./audioFiles";
import { buildExport } from "./exporter";
import { taskDir, taskService, type IntermediateBody } from "./taskService";

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

/** 建一个 3 段 / 2 章的任务，并为每段写入内容匹配的音频文件。 */
function setupTask(): number {
  const id = taskService.create({ name: uniqueName("exporter"), params_json: "{}" });
  const body: IntermediateBody = {
    text: "第一段。\n第二段。\n第三段。",
    sources: ["text/part0000.html", "text/part0001.html"],
    segments: {
      "001": { text: "第一段。", phonetic: "", source: "text/part0000.html" },
      "002": { text: "第二段。", phonetic: "", source: "text/part0000.html" },
      "003": { text: "第三段。", phonetic: "", source: "text/part0001.html" },
    },
  };
  fs.mkdirSync(taskDir(id), { recursive: true });
  fs.writeFileSync(path.join(taskDir(id), "intermediate.json"), JSON.stringify(body, null, 2), "utf8");
  for (const [key, seg] of Object.entries(body.segments)) {
    fs.writeFileSync(
      path.join(taskDir(id), buildAudioFileName(key, segmentContentHash(seg), "wav")),
      `audio-${key}`,
      "utf8",
    );
  }
  return id;
}

test("scope=selected + zip 打包选中分段的音频文件", async () => {
  const id = setupTask();
  try {
    const result = await buildExport(id, { scope: "selected", format: "zip", keys: ["001", "003"] });
    assert.equal(result.contentType, "application/zip");
    assert.match(result.filename, /-selected-segments\.zip$/);

    const names = new AdmZip(result.buffer).getEntries().map((e) => e.entryName).sort();
    assert.equal(names.length, 2);
    assert.ok(names.every((n) => /^(001|003)-[0-9a-f]{40}\.wav$/.test(n)), JSON.stringify(names));
  } finally {
    if (taskService.get(id)) taskService.remove(id);
    else if (fs.existsSync(taskDir(id))) fs.rmSync(taskDir(id), { recursive: true, force: true });
  }
});

test("scope=chapters + zip 按「章名/分段音频」组织", async () => {
  const id = setupTask();
  try {
    const result = await buildExport(id, { scope: "chapters", format: "zip" });
    assert.equal(result.contentType, "application/zip");
    assert.match(result.filename, /-chapters-segments\.zip$/);

    const names = new AdmZip(result.buffer).getEntries().map((e) => e.entryName).sort();
    assert.equal(names.filter((n) => n.startsWith("part0000/")).length, 2, JSON.stringify(names));
    assert.equal(names.filter((n) => n.startsWith("part0001/")).length, 1, JSON.stringify(names));
    assert.ok(names.every((n) => /^part000[01]\/\d+-[0-9a-f]{40}\.wav$/.test(n)), JSON.stringify(names));
  } finally {
    if (taskService.get(id)) taskService.remove(id);
    else if (fs.existsSync(taskDir(id))) fs.rmSync(taskDir(id), { recursive: true, force: true });
  }
});

test("导出缺失音频的分段时报错", async () => {
  const id = setupTask();
  try {
    await assert.rejects(
      buildExport(id, { scope: "selected", format: "zip", keys: ["001", "999"] }),
      /还没有语音/,
    );
  } finally {
    if (taskService.get(id)) taskService.remove(id);
    else if (fs.existsSync(taskDir(id))) fs.rmSync(taskDir(id), { recursive: true, force: true });
  }
});

test("未选分段时导出选中范围报错", async () => {
  const id = setupTask();
  try {
    await assert.rejects(
      buildExport(id, { scope: "selected", format: "zip", keys: [] }),
      /请先选择要导出的段落/,
    );
  } finally {
    if (taskService.get(id)) taskService.remove(id);
    else if (fs.existsSync(taskDir(id))) fs.rmSync(taskDir(id), { recursive: true, force: true });
  }
});
