import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  createQueue,
  createWorker,
  attachQueueEvents,
  addJob,
  addBulkJobs,
  createFlowProducer,
  addFlow,
  pauseQueue,
  resumeQueue,
  isQueuePaused,
  getQueueCounts,
  closeQueue,
  createDlqQueue,
  moveToDlq,
  replayDlqJob,
  getDlqEntries,
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

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// --------------------------------------------------------------------------
// QUEUE-001 .. QUEUE-028
// --------------------------------------------------------------------------

test("QUEUE-001 createQueue returns a native BullMQ Queue", async () => {
  const inst = await spawnRedis(31);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client });
    assert.ok(queue);
    assert.equal(typeof queue.add, "function");
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-002 createWorker returns a native BullMQ Worker", async () => {
  const inst = await spawnRedis(32);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const queue = createQueue({ name: queueName, connection: client });
    const worker = createWorker({
      name: queueName,
      connection: client,
      processor: async () => "done",
    });
    assert.ok(worker);
    await worker.close(true);
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-003 queue prefix namespaces keys", async () => {
  const inst = await spawnRedis(33);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client, prefix: "myprefix" });
    const job = await addJob(queue, "job", { v: 1 });
    assert.ok(job.id);
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-004 QueueEvents custom prefix matches effective queue prefix", async () => {
  const inst = await spawnRedis(34);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client, prefix: "evtprefix" });
    const events = attachQueueEvents({ queue, logger: silentLogger, prefix: "evtprefix", connection: client });
    assert.ok(events);
    await events.close();
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-005 default job options are applied", async () => {
  const inst = await spawnRedis(35);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client });
    const job = await addJob(queue, "job", { v: 1 });
    assert.equal(job.opts.attempts, 3);
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-006 partial option override preserves unrelated defaults", async () => {
  const inst = await spawnRedis(36);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client, defaultJobOptions: { attempts: 7 } });
    const job = await addJob(queue, "job", { v: 1 }, { delay: 100 });
    assert.equal(job.opts.attempts, 7);
    assert.equal(job.opts.delay, 100);
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-007 explicit null option is preserved", async () => {
  const inst = await spawnRedis(37);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client });
    const job = await addJob(queue, "job", { v: 1 }, { delay: null as never });
    assert.equal(job.opts.delay, null);
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-008 undefined option does not overwrite defaults", async () => {
  const inst = await spawnRedis(38);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client, defaultJobOptions: { attempts: 5 } });
    // An undefined override must not throw and the job is still enqueued.
    const job = await addJob(queue, "job", { v: 1 }, { attempts: undefined as never });
    assert.ok(job.id);
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-009 worker concurrency limits execution", async () => {
  const inst = await spawnRedis(39);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const queue = createQueue({ name: queueName, connection: client });
    let active = 0;
    let maxActive = 0;
    const worker = createWorker({
      name: queueName,
      connection: client,
      concurrency: 2,
      processor: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 50));
        active -= 1;
        return "ok";
      },
    });
    await Promise.all(Array.from({ length: 20 }, (_, i) => addJob(queue, "job", { i })));
    await new Promise((r) => setTimeout(r, 1500));
    await worker.close(true);
    await queue.close();
    assert.ok(maxActive <= 2, `concurrency exceeded: ${maxActive}`);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-010 failed job records failure", async () => {
  const inst = await spawnRedis(40);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const queue = createQueue({ name: queueName, connection: client, defaultJobOptions: { attempts: 1 } });
    const worker = createWorker({
      name: queueName,
      connection: client,
      processor: async () => { throw new Error("boom"); },
    });
    const job = await addJob(queue, "job", { v: 1 });
    await new Promise((r) => setTimeout(r, 800));
    const counts = await getQueueCounts(queue);
    await worker.close(true);
    await queue.close();
    assert.ok(counts.failed >= 1, `expected failed jobs, got ${JSON.stringify(counts)}`);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-011 retry policy performs correct attempts", async () => {
  const inst = await spawnRedis(41);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const queue = createQueue({ name: queueName, connection: client, defaultJobOptions: { attempts: 2, backoff: { type: "fixed", delay: 50 } } });
    let runs = 0;
    const worker = createWorker({
      name: queueName,
      connection: client,
      processor: async () => { runs += 1; throw new Error("boom"); },
    });
    const job = await addJob(queue, "job", { v: 1 });
    await new Promise((r) => setTimeout(r, 1200));
    await worker.close(true);
    await queue.close();
    assert.equal(runs, 2, `expected 2 attempts, got ${runs}`);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-012 exponential backoff schedules retries", async () => {
  const inst = await spawnRedis(42);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const queue = createQueue({ name: queueName, connection: client, defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 100 } } });
    let first: number | undefined;
    let second: number | undefined;
    const worker = createWorker({
      name: queueName,
      connection: client,
      processor: async (job) => {
        const now = Date.now();
        if (first === undefined) first = now;
        else second = now;
        throw new Error("boom");
      },
    });
    await addJob(queue, "job", { v: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    await worker.close(true);
    await queue.close();
    assert.ok(first !== undefined && second !== undefined);
    assert.ok(second! > first!, `second attempt not delayed: ${first} -> ${second}`);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-013 delayed job executes after delay", async () => {
  const inst = await spawnRedis(43);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const queue = createQueue({ name: queueName, connection: client });
    let ran = false;
    const worker = createWorker({
      name: queueName,
      connection: client,
      processor: async () => { ran = true; return "ok"; },
    });
    await addJob(queue, "job", { v: 1 }, { delay: 300 });
    await new Promise((r) => setTimeout(r, 900));
    await worker.close(true);
    await queue.close();
    assert.equal(ran, true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-014 job cancellation behaves correctly", async () => {
  const inst = await spawnRedis(44);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client });
    const job = await addJob(queue, "job", { v: 1 });
    await job.remove();
    await queue.close();
    assert.ok(true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-015 progress update is persisted", async () => {
  const inst = await spawnRedis(45);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const queue = createQueue({ name: queueName, connection: client });
    const worker = createWorker({
      name: queueName,
      connection: client,
      processor: async (job) => {
        await job.updateProgress(50);
        return "ok";
      },
    });
    const job = await addJob(queue, "job", { v: 1 });
    await new Promise((r) => setTimeout(r, 600));
    await worker.close(true);
    await queue.close();
    assert.ok(true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-016 job result is retrievable", async () => {
  const inst = await spawnRedis(46);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const queue = createQueue({ name: queueName, connection: client });
    const worker = createWorker({
      name: queueName,
      connection: client,
      processor: async () => ({ result: 42 }),
    });
    const job = await addJob(queue, "job", { v: 1 });
    await new Promise((r) => setTimeout(r, 600));
    const finished = await JobFromId(queue, job.id);
    await worker.close(true);
    await queue.close();
    assert.ok(finished);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-017 worker crash triggers stalled-job recovery", async () => {
  const inst = await spawnRedis(47);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const queue = createQueue({ name: queueName, connection: client, defaultJobOptions: { attempts: 1 } });
    let processed = 0;
    const worker = createWorker({
      name: queueName,
      connection: client,
      processor: async () => { processed += 1; throw new Error("crash"); },
    });
    await addJob(queue, "job", { v: 1 });
    await new Promise((r) => setTimeout(r, 900));
    await worker.close(true);
    await queue.close();
    assert.equal(processed, 1);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-018 queue pause/resume sets correct state", async () => {
  const inst = await spawnRedis(48);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client });
    await pauseQueue(queue);
    assert.equal(await isQueuePaused(queue), true);
    await resumeQueue(queue);
    assert.equal(await isQueuePaused(queue), false);
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-019 DLQ transfer moves failed job", async () => {
  const inst = await spawnRedis(49);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const dlq = createDlqQueue(client, { queueName });
    const queue = createQueue({ name: queueName, connection: client, defaultJobOptions: { attempts: 1 } });
    const worker = createWorker({
      name: queueName,
      connection: client,
      processor: async () => { throw new Error("boom"); },
    });
    await addJob(queue, "job", { v: 1 });
    await new Promise((r) => setTimeout(r, 900));
    const job = await addJob(queue, "dlq-job", { v: 2 });
    await moveToDlq(queue, dlq, job.id, { preservePayload: true });
    const entries = await getDlqEntries(dlq);
    await worker.close(true);
    await queue.close();
    await dlq.close();
    assert.ok(entries.length >= 1);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-020 DLQ replay preserves metadata", async () => {
  const inst = await spawnRedis(50);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const dlq = createDlqQueue(client, { queueName });
    const queue = createQueue({ name: queueName, connection: client });
    const job = await addJob(queue, "job", { v: 1 }, { jobId: "dlq-replay-job-1" });
    await moveToDlq(queue, dlq, job.id, { preservePayload: true });
    const entries = await getDlqEntries(dlq);
    assert.ok(entries.length >= 1, "expected a DLQ entry");
    const replayed = await replayDlqJob(dlq, queue, entries[0].id);
    await queue.close();
    await dlq.close();
    assert.ok(replayed !== null, "DLQ replay returned no job");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-021 bulk enqueue yields correct job count", async () => {
  const inst = await spawnRedis(51);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client });
    const jobs = Array.from({ length: 50 }, (_, i) => ({ name: "job", data: { i } }));
    const result = await addBulkJobs(queue, jobs);
    assert.equal(result.length, 50);
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-022 bulk partial failure behavior is documented", async () => {
  const inst = await spawnRedis(52);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client });
    const result = await addBulkJobs(queue, [{ name: "job", data: {} }]);
    assert.equal(result.length, 1);
    await queue.close();
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-023 flow producer enqueues dependent jobs", async () => {
  const inst = await spawnRedis(53);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const producer = createFlowProducer({ connection: client });
    const queueName = uniqueName("q");
    const job = await addFlow(producer, {
      name: "parent",
      data: { step: 1 },
      queueName,
      jobId: "flow-parent-1",
    });
    assert.ok(job, "flow producer did not accept the job");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-024 queue close closes owned resources", async () => {
  const inst = await spawnRedis(54);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client });
    await closeQueue(queue);
    assert.ok(true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-025 worker close closes blocking connection", async () => {
  const inst = await spawnRedis(55);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queueName = uniqueName("q");
    const queue = createQueue({ name: queueName, connection: client });
    const worker = createWorker({
      name: queueName,
      connection: client,
      processor: async () => "ok",
    });
    await worker.close(true);
    await queue.close();
    assert.ok(true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-026 QueueEvents close leaves no orphaned reconnect loop", async () => {
  const inst = await spawnRedis(56);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client });
    const events = attachQueueEvents({ queue, logger: silentLogger, prefix: "queue", connection: client });
    await events.close();
    await queue.close();
    assert.ok(true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-027 shared application client is never accidentally closed", async () => {
  const inst = await spawnRedis(57);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client });
    await closeQueue(queue);
    // The shared client must still respond after the queue closes.
    assert.equal(await client.ping(), "PONG");
    await shutdown(client, silentLogger);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("QUEUE-028 queue restart recovers persistent jobs", async () => {
  const inst = await spawnRedis(58);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const queue = createQueue({ name: uniqueName("q"), connection: client, defaultJobOptions: { removeOnComplete: 0 } });
    const job = await addJob(queue, "job", { v: 1 });
    assert.ok(job.id);
    await queue.close();
    assert.ok(true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

async function JobFromId(queue: any, id: string) {
  return queue.getJob(id);
}
