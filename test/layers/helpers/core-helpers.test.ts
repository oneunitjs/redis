import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildKey,
  serialize,
  deserialize,
  jitterTtl,
  setIfAbsent,
  compareAndSwap,
  detectCapabilities,
} from "@oneunit/redis";
import { createClient, shutdown, silentLogger } from "@oneunit/redis";
import { spawnRedis } from "../../helpers/redis-spawn.js";

test("HELPER-001 buildKey joins validated segments", () => {
  assert.equal(buildKey("user", 42, "session"), "user:42:session");
  assert.throws(() => buildKey(""), /empty/i);
  assert.throws(() => buildKey(null as never), /null/i);
  assert.throws(() => buildKey("  "), /empty/i);
});

test("HELPER-002 buildKey rejects missing segments", () => {
  assert.throws(() => buildKey(), /at least one/i);
});

test("HELPER-003 serialize round-trips JSON values", () => {
  const value = { foo: 1, bar: "x", nested: { a: [1, 2] } };
  assert.equal(deserialize(serialize(value)) && typeof (deserialize(serialize(value)) as object) === "object", true);
  assert.deepEqual(deserialize(serialize(value)), value);
  assert.equal(deserialize(null), null);
  assert.equal(deserialize(""), null);
  assert.equal(deserialize(undefined), null);
  assert.equal(deserialize("{not json"), null);
});

test("HELPER-004 jitterTtl stays within bounds", () => {
  for (let i = 0; i < 100; i += 1) {
    const value = jitterTtl(100, 0.1);
    assert.ok(value >= 90 && value <= 110, `out of bounds: ${value}`);
  }
  assert.throws(() => jitterTtl(0), /positive/);
  assert.throws(() => jitterTtl(-5), /positive/);
  assert.throws(() => jitterTtl(100, 1.5), /between 0 and 1/);
});

test("HELPER-005 setIfAbsent behaves as an atomic write gate", async () => {
  const inst = await spawnRedis(81);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    await client.flushdb();
    assert.equal(await setIfAbsent(client, "cas:key", "first", { ttlSeconds: 60 }), true);
    assert.equal(await setIfAbsent(client, "cas:key", "second"), false);
    assert.equal(await client.get("cas:key"), "first");
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger).catch(() => undefined);
    await inst.stop().catch(() => undefined);
  }
});

test("HELPER-006 compareAndSwap swaps only from the expected value", async () => {
  const inst = await spawnRedis(82);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    await client.flushdb();
    await client.set("cas:counter", "1");
    assert.equal(await compareAndSwap(client, "cas:counter", "1", "2", { ttlSeconds: 60 }), true);
    assert.equal(await client.get("cas:counter"), "2");
    assert.equal(await compareAndSwap(client, "cas:counter", "stale", "3"), false);
    assert.equal(await client.get("cas:counter"), "2");
    assert.equal(await compareAndSwap(client, "cas:missing", null, "created"), true);
  } finally {
    await client.flushdb().catch(() => undefined);
    await shutdown(client, silentLogger).catch(() => undefined);
    await inst.stop().catch(() => undefined);
  }
});

test("HELPER-007 detectCapabilities reports server info", async () => {
  const inst = await spawnRedis(83);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const caps = await detectCapabilities(client);
    assert.ok(caps.version !== null);
    assert.equal(caps.isCluster, false);
    assert.equal(caps.hasStreams, true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
    await inst.stop().catch(() => undefined);
  }
});
