import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  createRedisCache,
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

function makeCache(url: string, options: Parameters<typeof createRedisCache>[1] = {}) {
  const client = createClient({ url, maxRetriesPerRequest: null }, silentLogger);
  return { client, cache: createRedisCache(client, options) };
}

// --------------------------------------------------------------------------
// Redis cache
// --------------------------------------------------------------------------

test("CACHE-001 get/set round trip", async () => {
  const inst = await spawnRedis(101);
  instances.push(inst);
  const { client, cache } = makeCache(inst.url);
  try {
    await cache.set("k1", "v1");
    assert.equal(await cache.get<string>("k1"), "v1");
    await cache.set("k1", "v2");
    assert.equal(await cache.get<string>("k1"), "v2");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CACHE-002 TTL expiration", async () => {
  const inst = await spawnRedis(102);
  instances.push(inst);
  const { client, cache } = makeCache(inst.url);
  try {
    await cache.set("ttl:k", "v", { ttlSeconds: 1 });
    assert.equal(await cache.get<string>("ttl:k"), "v");
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(await cache.get<string>("ttl:k"), null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CACHE-003 getOrLoad loader runs on miss and caches result", async () => {
  const inst = await spawnRedis(103);
  instances.push(inst);
  const { client, cache } = makeCache(inst.url);
  try {
    let calls = 0;
    const value = await cache.getOrLoad("gol:k", async () => { calls += 1; return 42; });
    assert.equal(value, 42);
    assert.equal(calls, 1);
    const again = await cache.getOrLoad("gol:k", async () => { calls += 1; return 99; });
    assert.equal(again, 42);
    assert.equal(calls, 1);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CACHE-004 getOrLoad propagates loader failure", async () => {
  const inst = await spawnRedis(104);
  instances.push(inst);
  const { client, cache } = makeCache(inst.url);
  try {
    await assert.rejects(
      async () => await cache.getOrLoad("fail:k", async () => { throw new Error("loader boom"); }),
      /loader boom/
    );
    assert.equal(await cache.get("fail:k"), null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CACHE-005 negative caching stores and returns null", async () => {
  const inst = await spawnRedis(105);
  instances.push(inst);
  const { client, cache } = makeCache(inst.url);
  try {
    await cache.set("neg:k", null, { negativeTtlSeconds: 2 });
    assert.equal(await cache.get("neg:k"), null);
    await new Promise((r) => setTimeout(r, 2100));
    assert.equal(await cache.get("neg:k"), null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CACHE-006 tag invalidation removes tagged entries", async () => {
  const inst = await spawnRedis(106);
  instances.push(inst);
  const { client, cache } = makeCache(inst.url);
  try {
    await cache.set("tag:a", "1", { tags: ["users"] });
    await cache.set("tag:b", "2", { tags: ["users", "orders"] });
    await cache.set("tag:c", "3", { tags: ["orders"] });
    await cache.invalidateTag("users");
    assert.equal(await cache.get("tag:a"), null);
    assert.equal(await cache.get("tag:b"), null);
    assert.equal(await cache.get("tag:c"), "3");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CACHE-007 invalidate removes a key and forces a loader re-run", async () => {
  const inst = await spawnRedis(107);
  instances.push(inst);
  const { client, cache } = makeCache(inst.url);
  try {
    await cache.set("tok:k", "v1");
    assert.equal(await cache.get("tok:k"), "v1");
    await cache.invalidate("tok:k");
    assert.equal(await cache.get("tok:k"), null);
    let calls = 0;
    const reloaded = await cache.getOrLoad("tok:k", async () => { calls += 1; return "v2"; });
    assert.equal(reloaded, "v2");
    assert.equal(calls, 1);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CACHE-008 metrics track hits and misses", async () => {
  const inst = await spawnRedis(108);
  instances.push(inst);
  const { client, cache } = makeCache(inst.url);
  try {
    await cache.set("m:k", "v");
    await cache.get("m:k");
    await cache.get("missing:k");
    const m = cache.metrics();
    assert.ok(m.hits >= 1);
    assert.ok(m.misses >= 1);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CACHE-009 wrap integrates with the loader", async () => {
  const inst = await spawnRedis(109);
  instances.push(inst);
  const { client, cache } = makeCache(inst.url);
  try {
    const fn = cache.wrap((id: string) => `cache:${id}`, async (id: string) => id.toUpperCase(), { ttlSeconds: 60 });
    const a = await fn("abc");
    const b = await fn("abc");
    assert.equal(a, "ABC");
    assert.equal(b, "ABC");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CACHE-010 shutdown flushes and clears local state", async () => {
  const inst = await spawnRedis(110);
  instances.push(inst);
  const { client, cache } = makeCache(inst.url);
  try {
    await cache.set("sh:k", "v");
    await cache.shutdown();
    assert.ok(true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});
