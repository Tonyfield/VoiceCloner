import assert from "node:assert/strict";
import test from "node:test";
import { withRetry } from "./retry";

test("withRetry 按退避间隔重试，全部失败后抛出最后一次错误", async () => {
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error(`fail-${calls}`);
      },
      { delaysMs: [1, 1, 1], onRetry: (_attempt, delayMs) => waits.push(delayMs) },
    ),
    /fail-4/,
  );
  assert.equal(calls, 4, "初次尝试 + 3 次重试");
  assert.deepEqual(waits, [1, 1, 1]);
});

test("withRetry 在第 N 次成功即返回，不再重试", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "ok";
    },
    { delaysMs: [1, 1, 1] },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("已取消（signal.aborted）时不重试", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("fail");
      },
      { signal: controller.signal, delaysMs: [1, 1, 1] },
    ),
    /fail/,
  );
  assert.equal(calls, 1, "取消后直接抛出，不重试");
});
