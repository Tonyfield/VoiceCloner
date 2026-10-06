import assert from "node:assert/strict";
import test from "node:test";
import { segmentLogService } from "./segmentLogService";
import { taskService } from "./taskService";

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

test("分段标记：点赞/点踩可含空反馈，可取消", () => {
  const id = taskService.create({ name: uniqueName("seg-log-marks"), params_json: "{}" });
  try {
    segmentLogService.setMark(id, "001", "like");
    segmentLogService.setMark(id, "002", "dislike", "断句不对");
    segmentLogService.setMark(id, "003", "dislike"); // 反馈可为空

    const marks = segmentLogService.listMarks(id);
    assert.equal(marks["001"].mark, "like");
    assert.equal(marks["001"].feedback, "");
    assert.equal(marks["002"].mark, "dislike");
    assert.equal(marks["002"].feedback, "断句不对");
    assert.equal(marks["003"].mark, "dislike");
    assert.equal(marks["003"].feedback, "");

    assert.deepEqual([...segmentLogService.markedKeys(id, "like")], ["001"]);
    assert.deepEqual([...segmentLogService.markedKeys(id, "dislike")].sort(), ["002", "003"]);

    // 改标记 / 取消标记
    segmentLogService.setMark(id, "002", "like");
    assert.equal(segmentLogService.listMarks(id)["002"].mark, "like");
    segmentLogService.setMark(id, "001", null);
    assert.equal(segmentLogService.listMarks(id)["001"], undefined);
  } finally {
    if (taskService.get(id)) taskService.remove(id);
  }
});

test("分段步骤：记录时间、分段长度、注音输入输出、合成状态/耗时/报错", () => {
  const id = taskService.create({ name: uniqueName("seg-log-steps"), params_json: "{}" });
  try {
    segmentLogService.logStep(id, "001", "segment", { length: 42, source: "part0000" });
    segmentLogService.logStep(id, "001", "phonetic", { operation: "自动注音", input: "阿房宫", output: "<phoneme pinyin=\"e1\">阿</phoneme>" });
    segmentLogService.logStep(id, "001", "synthesize", { input: "<阿|e1>房宫" }, { status: 200, durationMs: 1234 });
    segmentLogService.logStep(id, "001", "synthesize", { input: "<阿|e1>房宫" }, { status: 400, durationMs: 88, error: "TTS API 返回 HTTP 400" });

    const steps = segmentLogService.listSteps(id, "001");
    assert.equal(steps.length, 4);
    assert.equal(steps[0].step, "segment");
    assert.equal(steps[0].detail.length, 42);
    assert.ok(steps[0].created_at, "总是记录时间");
    assert.equal(steps[1].step, "phonetic");
    assert.equal(steps[1].detail.input, "阿房宫");
    assert.match(String(steps[1].detail.output), /phoneme/);
    assert.equal(steps[2].status, 200);
    assert.equal(steps[2].duration_ms, 1234);
    assert.equal(steps[3].status, 400);
    assert.match(String(steps[3].error), /HTTP 400/);

    // 只返回该分段的记录
    segmentLogService.logStep(id, "002", "segment", { length: 10 });
    assert.equal(segmentLogService.listSteps(id, "001").length, 4);
    assert.equal(segmentLogService.listSteps(id, "002").length, 1);
  } finally {
    if (taskService.get(id)) taskService.remove(id);
  }
});

test("删除任务时同时清除标记与步骤记录", () => {
  const id = taskService.create({ name: uniqueName("seg-log-remove"), params_json: "{}" });
  segmentLogService.setMark(id, "001", "like");
  segmentLogService.logStep(id, "001", "segment", { length: 1 });
  assert.equal(segmentLogService.listSteps(id, "001").length, 1);

  taskService.remove(id);
  assert.deepEqual(segmentLogService.listMarks(id), {});
  assert.deepEqual(segmentLogService.listSteps(id, "001"), []);
});
