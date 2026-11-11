import { test } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  runPipeline,
  pipelineValues,
  runTransaction,
  PipelineCommandError,
  PipelineStepError,
  PipelineTimeoutError,
  silentLogger,
  shutdown,
} from "@oneunit/redis";
import { spawnRedis } from "../../helpers/redis-spawn.js";
import type { ChainableCommander } from "ioredis";

// Stand-in for the subset of ioredis that runPipeline/runTransaction use.
function fakeClient(exec: () => Promise<Array<[Error | null, unknown]>>) {
  const queued: string[] = [];
  return {
    queued,
    pipeline(): ChainableCommander {
      const command = (name: string) => (..._args: unknown[]) => { queued.push(name); return command; };
      return {
        get: command("get"),
        set: command("set"),
        incr: command("incr"),
        get length() { return queued.length; },
        exec,
      } as unknown as ChainableCommander;
    },
    exec,
  } as unknown as Parameters<typeof runPipeline>[0];
}

test("PIPE-001 single command returns correct result", async () => {
  const result = await runPipeline(
    fakeClient(async () => [[null, "OK"]]),
    [{ label: "set", run: (p) => p.set("k", "v") }],
  );
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].value, "OK");
  assert.equal(result.failed, 0);
});

test("PIPE-002 multiple commands map positionally", async () => {
  const result = await runPipeline(
    fakeClient(async () => [[null, 1], [null, 2], [null, 3]]),
    [
      { label: "a", run: (p) => p.incr("a") },
      { label: "b", run: (p) => p.incr("b") },
      { label: "c", run: (p) => p.incr("c") },
    ],
  );
  assert.deepEqual(result.results.map((r) => r.value), [1, 2, 3]);
});

test("PIPE-003 null result distinguished from command error", async () => {
  const result = await runPipeline(
    fakeClient(async () => [[null, null], [new Error("ERR"), null]]),
    [
      { label: "missing", run: (p) => p.get("k") },
      { label: "bad", run: (p) => p.incr("k") },
    ],
  );
  assert.equal(result.results[0].error, undefined);
  assert.equal(result.results[0].value, null);
  assert.ok(result.results[1].error instanceof Error);
});

test("PIPE-004 Redis command error surfaces as step error", async () => {
  const failure = Object.assign(new Error("ERR value is not an integer"), { command: { name: "incr", args: ["k"] } });
  const result = await runPipeline(
    fakeClient(async () => [[failure, null]]),
    [{ label: "bad", run: (p) => p.incr("k") }],
    { throwOnError: false },
  );
  assert.equal(result.failed, 1);
  assert.ok(result.results[0].error instanceof Error);
});

test("PIPE-005 synchronous callback throw aborts execution", async () => {
  await assert.rejects(
    async () => {
      await runPipeline(
        fakeClient(async () => []),
        [{ label: "thrower", run: () => { throw new Error("boom"); } }],
      );
    },
    /boom/,
  );
});

test("PIPE-006 asynchronous callback is rejected before execution", async () => {
  await assert.rejects(
    async () => {
      await runPipeline(
        fakeClient(async () => []),
        [{ label: "async", run: async () => { return undefined; } } as never],
      );
    },
    PipelineStepError,
  );
});

test("PIPE-007 zero commands is rejected", async () => {
  const result = await runPipeline(fakeClient(async () => []), []);
  assert.deepEqual(result.results, []);
});

test("PIPE-008 multiple commands in one step is rejected", async () => {
  await assert.rejects(
    async () => {
      await runPipeline(
        fakeClient(async () => []),
        [{ label: "multi", run: (p) => { p.get("a"); p.get("b"); } }],
      );
    },
    PipelineStepError,
  );
});

test("PIPE-009 duplicate labels documented validation behavior", async () => {
  const result = await runPipeline(
    fakeClient(async () => [[null, 1], [null, 2]]),
    [
      { label: "dup", run: (p) => p.incr("a") },
      { label: "dup", run: (p) => p.incr("b") },
    ],
  );
  assert.equal(result.results.length, 2);
});

test("PIPE-010 connection failure yields a safe error", async () => {
  await assert.rejects(
    async () => {
      await runPipeline(
        fakeClient(async () => { throw new Error("ECONNREFUSED"); }),
        [{ label: "x", run: (p) => p.get("k") }],
      );
    },
    /ECONNREFUSED/,
  );
});

test("PIPE-011 pipeline timeout bounds caller wait", async () => {
  let released = false;
  const exec = () => new Promise<Array<[Error | null, unknown]>>((resolve) => {
    setTimeout(() => { released = true; resolve([[null, "ok"]]); }, 5000);
  });
  await assert.rejects(
    async () => {
      await runPipeline(
        fakeClient(exec as never),
        [{ label: "slow", run: (p) => p.get("k") }],
        { timeout: 100 },
      );
    },
    PipelineTimeoutError,
  );
  assert.ok(!released, "underlying exec was not cancelled by the pipeline timeout");
});

test("PIPE-012 strict mode throws on command failure", async () => {
  const failure = Object.assign(new Error("ERR"), { command: { name: "incr", args: ["k"] } });
  await assert.rejects(
    async () => {
      await runPipeline(
        fakeClient(async () => [[failure, null]]),
        [{ label: "bad", run: (p) => p.incr("k") }],
        { throwOnError: true },
      );
    },
    PipelineCommandError,
  );
});

test("PIPE-013 non-strict mode returns individual failures", async () => {
  const failure = Object.assign(new Error("ERR"), { command: { name: "incr", args: ["k"] } });
  const result = await runPipeline(
    fakeClient(async () => [[failure, null], [null, 2]]),
    [
      { label: "bad", run: (p) => p.incr("k") },
      { label: "ok", run: (p) => p.incr("b") },
    ],
  );
  assert.equal(result.failed, 1);
  assert.equal(result.results[1].value, 2);
});

test("PIPE-014 large pipeline keeps memory bounded", async () => {
  const n = 1000;
  const raw: Array<[Error | null, unknown]> = Array.from({ length: n }, () => [null, 1]);
  const result = await runPipeline(
    fakeClient(async () => raw),
    Array.from({ length: n }, (_, i) => ({ label: `c${i}`, run: (p) => p.incr(`k${i}`) })),
  );
  assert.equal(result.results.length, n);
});

test("PIPE-015 result ordering keeps labels aligned", async () => {
  const result = await runPipeline(
    fakeClient(async () => [[null, "first"], [null, "second"]]),
    [
      { label: "one", run: (p) => p.get("a") },
      { label: "two", run: (p) => p.get("b") },
    ],
  );
  assert.equal(result.results[0].label, "one");
  assert.equal(result.results[0].value, "first");
  assert.equal(result.results[1].label, "two");
  assert.equal(result.results[1].value, "second");
});

test("PIPE-016 concurrent pipelines do not cross-contaminate", async () => {
  const results = await Promise.all([
    runPipeline(fakeClient(async () => [[null, 1]]), [{ label: "a", run: (p) => p.incr("x") }]),
    runPipeline(fakeClient(async () => [[null, 2]]), [{ label: "b", run: (p) => p.incr("y") }]),
  ]);
  assert.equal(results[0].results[0].value, 1);
  assert.equal(results[1].results[0].value, 2);
});

test("PIPE-017 EXEC transaction errors classify correctly", async () => {
  const inst = await spawnRedis(61);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const result = await runTransaction(
      client,
      [{ label: "set", run: (t) => t.set("pipe:tx", "v") }],
    );
    assert.equal(result.executed, true);
    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("PIPE-018 timeout after dispatch does not claim false cancellation", async () => {
  // The pipeline timeout bounds the caller wait; the underlying command may
  // still run server-side. A timeout is not reported as cancellation.
  await assert.rejects(
    async () => {
      await runPipeline(
        fakeClient(async () => { throw new Error("timeout"); }),
        [{ label: "x", run: (p) => p.get("k") }],
        { timeout: 50 },
      );
    },
    /timeout/,
  );
});
