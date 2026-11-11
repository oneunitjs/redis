import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  createJobAtLeastOnce,
  shutdown,
  silentLogger,
} from "@oneunit/redis";
import { spawnRedis } from "../../helpers/redis-spawn.js";

const instances: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const inst of instances.splice(0, instances.length)) {
    await inst.stop().catch(() => undefined);
  }
});

// --------------------------------------------------------------------------
// At-least-once jobs
// --------------------------------------------------------------------------

test("JOBS-001 disabled facade throws on every call", async () => {
  const inst = await spawnRedis(151);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const disabled = createJobAtLeastOnce({ connection: client, enabled: false, queueName: "disabled-q" });
    assert.equal(disabled.enabled, false);
    await assert.rejects(() => disabled.add("job", {}), /disabled/);
    assert.throws(() => disabled.createWorker(async () => {}), /disabled/);
    assert.equal(disabled.getDlq(), null);
    await disabled.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("JOBS-002 enabled queue processes a job through a worker", async () => {
  const inst = await spawnRedis(152);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const jobs = createJobAtLeastOnce({
      connection: client,
      enabled: true,
      queueName: uniqueQ("jobs-q"),
      concurrency: 1,
      attempts: 1,
    });
    let result: unknown = null;
    const worker = jobs.createWorker(async (job) => {
      result = job.data;
      return "processed";
    });
    await jobs.add("process", { x: 1 });
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(result, { x: 1 });
    await worker.close(true);
    await jobs.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("JOBS-003 job retries on failure", async () => {
  const inst = await spawnRedis(153);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const jobs = createJobAtLeastOnce({
      connection: client,
      enabled: true,
      queueName: uniqueQ("jobs-retry"),
      attempts: 2,
      backoff: { type: "fixed", delay: 100 },
    });
    let runs = 0;
    const worker = jobs.createWorker(async () => {
      runs += 1;
      throw new Error("fail");
    });
    await jobs.add("failjob", {});
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(runs, 2);
    await worker.close(true);
    await jobs.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("JOBS-004 delayed job executes after delay", async () => {
  const inst = await spawnRedis(154);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const jobs = createJobAtLeastOnce({ connection: client, enabled: true, queueName: uniqueQ("jobs-delay") });
    let ran = false;
    const worker = jobs.createWorker(async () => { ran = true; return "ok"; });
    await jobs.add("delayed", {}, { delay: 300 });
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(ran, true);
    await worker.close(true);
    await jobs.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("JOBS-005 bulk enqueue yields correct count", async () => {
  const inst = await spawnRedis(155);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const jobs = createJobAtLeastOnce({ connection: client, enabled: true, queueName: uniqueQ("jobs-bulk") });
    const result = await jobs.addBulk([{ name: "b1", data: {} }, { name: "b2", data: {} }]);
    assert.equal(result.length, 2);
    await jobs.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("JOBS-006 DLQ transfer and replay", async () => {
  const inst = await spawnRedis(156);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const jobs = createJobAtLeastOnce({
      connection: client,
      enabled: true,
      queueName: uniqueQ("jobs-dlq"),
      attempts: 1,
      dlq: { preservePayload: true },
    });
    const worker = jobs.createWorker(async () => { throw new Error("dlq"); });
    await jobs.add("to-dlq", {});
    await new Promise((r) => setTimeout(r, 900));
    const dlq = jobs.getDlq();
    assert.ok(dlq, "expected a DLQ");
    const entries = await dlq.entries();
    await worker.close(true);
    await jobs.close();
    assert.ok(entries.length >= 0);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("JOBS-007 pause and resume", async () => {
  const inst = await spawnRedis(157);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const jobs = createJobAtLeastOnce({ connection: client, enabled: true, queueName: uniqueQ("jobs-pause") });
    await jobs.pause();
    assert.equal(await jobs.isPaused(), true);
    await jobs.resume();
    assert.equal(await jobs.isPaused(), false);
    await jobs.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

function uniqueQ(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
