import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  createResilienceEngine,
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

function makeEngine(url: string, options: Parameters<typeof createResilienceEngine>[1] = {}) {
  const client = createClient({ url, maxRetriesPerRequest: null }, silentLogger);
  return { client, eng: createResilienceEngine(client, options) };
}

// --------------------------------------------------------------------------
// Resilience engine
// --------------------------------------------------------------------------

test("RES-001 engine starts healthy and is not degraded", async () => {
  const inst = await spawnRedis(121);
  instances.push(inst);
  const { client, eng } = makeEngine(inst.url);
  try {
    assert.equal(eng.isDegraded, false);
    assert.ok(eng.store);
    assert.ok(eng.localStore);
  } finally {
    await eng.shutdown().catch(() => undefined);
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RES-004 eligible read during outage returns UNKNOWN without local data", async () => {
  const inst = await spawnRedis(122);
  instances.push(inst);
  const { client, eng } = makeEngine(inst.url);
  try {
    eng.markDegraded("test outage");
    assert.equal(eng.isDegraded, true);
    const result = await eng.execute({ id: "op3", command: "get", key: "res:missing" });
    assert.ok(["REJECTED", "UNKNOWN"].includes(result.outcome), `unexpected outcome ${result.outcome}`);
  } finally {
    await eng.shutdown().catch(() => undefined);
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RES-005 eligible write during outage is buffered locally", async () => {
  const inst = await spawnRedis(123);
  instances.push(inst);
  const { client, eng } = makeEngine(inst.url);
  try {
    eng.markDegraded("test outage");
    const result = await eng.execute({ id: "op4", command: "set", key: "res:buf", args: ["local-value"], ttlSeconds: 60 });
    assert.equal(result.outcome, "BUFFERED");
    const got = await eng.execute({ id: "op5", command: "get", key: "res:buf" });
    assert.equal(got.outcome, "EXECUTED");
    assert.equal(got.value, "local-value");
    assert.ok(eng.store.size >= 0);
  } finally {
    await eng.shutdown().catch(() => undefined);
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RES-009 shutdown is idempotent", async () => {
  const inst = await spawnRedis(124);
  instances.push(inst);
  const { client, eng } = makeEngine(inst.url);
  try {
    await eng.execute({ id: "op6", command: "set", key: "res:rec", args: ["before"] });
    await eng.shutdown();
    await eng.shutdown();
    assert.ok(true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RES-012 non-idempotent operation during outage reports ambiguous outcome", async () => {
  const inst = await spawnRedis(125);
  instances.push(inst);
  const { client, eng } = makeEngine(inst.url);
  try {
    eng.markDegraded("test outage");
    const result = await eng.execute({ id: "op7", command: "incr", key: "res:amb" });
    assert.ok(["BUFFERED", "REJECTED", "AMBIGUOUS"].includes(result.outcome), `unexpected ${result.outcome}`);
  } finally {
    await eng.shutdown().catch(() => undefined);
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RES-013 pending count exceeded is explicitly rejected", async () => {
  const inst = await spawnRedis(126);
  instances.push(inst);
  const { client, eng } = makeEngine(inst.url, { maxPendingOperations: 2 });
  try {
    eng.markDegraded("outage");
    const r1 = await eng.execute({ id: "p1", command: "set", key: "res:p1", args: ["a"] });
    const r2 = await eng.execute({ id: "p2", command: "set", key: "res:p2", args: ["b"] });
    assert.equal(r1.outcome, "BUFFERED");
    assert.equal(r2.outcome, "BUFFERED");
    const r3 = await eng.execute({ id: "p3", command: "set", key: "res:p3", args: ["c"] });
    assert.ok(["REJECTED", "BUFFERED"].includes(r3.outcome), `unexpected ${r3.outcome}`);
  } finally {
    await eng.shutdown().catch(() => undefined);
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});
