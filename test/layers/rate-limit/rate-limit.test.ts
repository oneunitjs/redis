import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  createRateLimiter,
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

function limiter(url: string, options: Parameters<typeof createRateLimiter>[1]) {
  const client = createClient({ url, maxRetriesPerRequest: null }, silentLogger);
  return { client, lim: createRateLimiter(client, options) };
}

// --------------------------------------------------------------------------
// Rate limiting
// --------------------------------------------------------------------------

test("RATE-001 fixed window allows requests up to the limit", async () => {
  const inst = await spawnRedis(91);
  instances.push(inst);
  const { client, lim } = limiter(inst.url, { algorithm: "fixed-window", limit: 3, intervalMs: 1000 });
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => lim.consume("r1")));
    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;
    assert.equal(allowed, 3);
    assert.equal(denied, 2);
    assert.ok(results[3].retryAfterMs !== null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RATE-002 fixed window reset clears the counter", async () => {
  const inst = await spawnRedis(92);
  instances.push(inst);
  const { client, lim } = limiter(inst.url, { algorithm: "fixed-window", limit: 1, intervalMs: 10000 });
  try {
    assert.equal((await lim.consume("r2")).allowed, true);
    assert.equal((await lim.consume("r2")).allowed, false);
    await lim.reset("r2");
    assert.equal((await lim.consume("r2")).allowed, true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RATE-003 check mode does not consume allowance", async () => {
  const inst = await spawnRedis(93);
  instances.push(inst);
  const { client, lim } = limiter(inst.url, { algorithm: "fixed-window", limit: 1, intervalMs: 10000 });
  try {
    assert.equal((await lim.check("r3")).allowed, true);
    assert.equal((await lim.consume("r3")).allowed, true);
    assert.equal((await lim.consume("r3")).allowed, false);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RATE-004 sliding window allows up to the limit then denies", async () => {
  const inst = await spawnRedis(94);
  instances.push(inst);
  const { client, lim } = limiter(inst.url, { algorithm: "sliding-window", limit: 2, intervalMs: 1000 });
  try {
    assert.equal((await lim.consume("r4")).allowed, true);
    assert.equal((await lim.consume("r4")).allowed, true);
    assert.equal((await lim.consume("r4")).allowed, false);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RATE-005 token bucket consumes and refills", async () => {
  const inst = await spawnRedis(95);
  instances.push(inst);
  const { client, lim } = limiter(inst.url, {
    algorithm: "token-bucket",
    limit: 5,
    intervalMs: 1000,
    tokenBucket: { capacity: 3, refillRatePerSecond: 10, initialTokens: 3 },
  });
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => lim.consume("r5")));
    assert.equal(results.filter((r) => r.allowed).length, 3);
    assert.equal(results.filter((r) => !r.allowed).length, 2);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RATE-006 leaky bucket caps concurrent arrivals", async () => {
  const inst = await spawnRedis(96);
  instances.push(inst);
  const { client, lim } = limiter(inst.url, {
    algorithm: "leaky-bucket",
    limit: 3,
    intervalMs: 1000,
    leakyBucket: { capacity: 3, leakRatePerSecond: 5 },
  });
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => lim.consume("r6")));
    assert.equal(results.filter((r) => r.allowed).length, 3);
    assert.equal(results.filter((r) => !r.allowed).length, 3);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RATE-007 weighted consumption is atomic", async () => {
  const inst = await spawnRedis(97);
  instances.push(inst);
  const { client, lim } = limiter(inst.url, { algorithm: "fixed-window", limit: 10, intervalMs: 10000, costUnit: 1 });
  try {
    const expensive = await lim.consume("r7", 6);
    assert.equal(expensive.allowed, true);
    const remaining = await lim.consume("r7", 4);
    assert.equal(remaining.allowed, true);
    const over = await lim.consume("r7", 1);
    assert.equal(over.allowed, false);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RATE-008 invalid limit throws a configuration error", () => {
  const client = createClient({ url: "redis://127.0.0.1:6379/0", maxRetriesPerRequest: null }, silentLogger);
  assert.throws(() => createRateLimiter(client, { algorithm: "fixed-window", limit: 0, intervalMs: 1000 }), /limit/);
  assert.throws(() => createRateLimiter(client, { algorithm: "bogus" as never, limit: 1, intervalMs: 1000 }), /algorithm/);
  client.disconnect();
});

test("RATE-009 fixed window retryAfter is set when denied", async () => {
  const inst = await spawnRedis(98);
  instances.push(inst);
  const { client, lim } = limiter(inst.url, { algorithm: "fixed-window", limit: 1, intervalMs: 1000 });
  try {
    assert.equal((await lim.consume("r9")).allowed, true);
    const denied = await lim.consume("r9");
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterMs !== null && denied.retryAfterMs! > 0);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("RATE-010 shared counter across multiple clients on the same Redis", async () => {
  const inst = await spawnRedis(99);
  instances.push(inst);
  const clients = Array.from({ length: 3 }, () =>
    createClient({ url: inst.url, maxRetriesPerRequest: null }, silentLogger)
  );
  try {
    const limiters = clients.map((c) => createRateLimiter(c, { algorithm: "fixed-window", limit: 3, intervalMs: 10000 }));
    const results = await Promise.all(limiters.map((l) => l.consume("shared")));
    assert.equal(results.filter((r) => r.allowed).length, 3);
    const denied = await limiters[0].consume("shared");
    assert.equal(denied.allowed, false);
  } finally {
    await Promise.all(clients.map((c) => shutdown(c, silentLogger).catch(() => undefined)));
  }
});
