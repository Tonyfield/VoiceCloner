import assert from "node:assert/strict";
import test from "node:test";
import { errorService } from "./errorService";
import { taskService } from "./taskService";

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

test("errorService 记录/查询/计数/清除任务错误", () => {
  const id = taskService.create({ name: uniqueName("error-service"), params_json: "{}" });
  try {
    assert.equal(errorService.count(id), 0);
    assert.deepEqual(errorService.list(id), []);

    errorService.record(id, "synthesize", "001: TTS 服务不可用");
    errorService.record(id, "task", new Error("重试耗尽"));

    assert.equal(errorService.count(id), 2);
    const rows = errorService.list(id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].stage, "task", "按 id 倒序，最新在前");
    assert.match(rows[1].message, /001: TTS 服务不可用/);

    assert.equal(errorService.clear(id), 2);
    assert.equal(errorService.count(id), 0);
  } finally {
    if (taskService.get(id)) taskService.remove(id);
  }
});

test("删除任务时同时清除其错误历史", () => {
  const id = taskService.create({ name: uniqueName("error-service-remove"), params_json: "{}" });
  errorService.record(id, "task", "boom");
  assert.equal(errorService.count(id), 1);

  taskService.remove(id);
  assert.equal(errorService.count(id), 0);
});
