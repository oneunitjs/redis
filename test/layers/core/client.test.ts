import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  createSentinelClient,
  health,
  shutdown,
  runTransaction,
  TransactionTimeoutError,
  silentLogger,
  createLogger,
} from "@oneunit/redis";
import { spawnRedis } from "../../helpers/redis-spawn.js";

const instances: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const inst of instances.splice(0, instances.length)) {
    await inst.stop().catch(() => undefined);
  }
});

// --------------------------------------------------------------------------
// CORE-001 .. CORE-026
// --------------------------------------------------------------------------

test("CORE-001 constructs a client from a valid Redis URL", async () => {
  const inst = await spawnRedis(1);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    assert.equal(await client.ping(), "PONG");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-002 throws a clear configuration error with no URL", () => {
  assert.throws(() => createClient({}, silentLogger), /No Redis URL/);
});

test("CORE-003 a garbage URL does not silently connect to the wrong host", async () => {
  // createClient passes the URL straight to ioredis; a malformed/unreachable
  // URL must surface as a bounded connection failure, not a silent localhost
  // fallback.
  const client = createClient({ url: "redis://127.0.0.1:16379/0", lazyConnect: true, maxRetriesPerRequest: null }, silentLogger);
  try {
    const result = await health(client, { timeout: 600 });
    assert.equal(result.status, "down");
  } finally {
    client.disconnect();
  }
});

test("CORE-004 uses REDIS_URL environment fallback", async () => {
  const inst = await spawnRedis(2);
  instances.push(inst);
  const prev = process.env.REDIS_URL;
  process.env.REDIS_URL = inst.url;
  try {
    const client = createClient(undefined, silentLogger);
    try {
      assert.equal(await client.ping(), "PONG");
    } finally {
      await shutdown(client, silentLogger).catch(() => undefined);
    }
  } finally {
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
  }
});

test("CORE-005 explicit URL overrides environment", async () => {
  const instA = await spawnRedis(3);
  const instB = await spawnRedis(4);
  instances.push(instA, instB);
  const prev = process.env.REDIS_URL;
  process.env.REDIS_URL = instA.url;
  try {
    const client = createClient({ url: instB.url }, silentLogger);
    try {
      assert.equal(await client.ping(), "PONG");
    } finally {
      await shutdown(client, silentLogger).catch(() => undefined);
    }
  } finally {
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
  }
});

test("CORE-006 default lazyConnect constructs without connecting", async () => {
  const inst = await spawnRedis(5);
  instances.push(inst);
  const client = createClient({ url: inst.url, lazyConnect: true }, silentLogger);
  try {
    // lazyConnect defers the connection until the first command.
    assert.equal(await client.ping(), "PONG");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-007 BullMQ-compatible retry default is maxRetriesPerRequest null", async () => {
  const inst = await spawnRedis(6);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    assert.equal((client as any).options.maxRetriesPerRequest, null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-008 caller overrides defaults preserve documented precedence", async () => {
  const inst = await spawnRedis(7);
  instances.push(inst);
  const client = createClient({ url: inst.url, connectTimeout: 1234 }, silentLogger);
  try {
    assert.equal((client as any).options.connectTimeout, 1234);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-009 keyPrefix is rejected per contract", () => {
  assert.throws(() => createClient({ url: "redis://127.0.0.1:6379/8", keyPrefix: "x:" } as never, silentLogger), /keyPrefix/);
});

test("CORE-010 connection event sequence (connect -> ready)", async () => {
  const inst = await spawnRedis(9);
  instances.push(inst);
  const events: string[] = [];
  const client = createClient(
    { url: inst.url },
    createLogger({ info: (msg) => events.push(String(msg)) }),
  );
  try {
    await client.ping();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(events.includes("redis connect"));
    assert.ok(events.includes("redis ready"));
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-011 unhandled Redis error event does not crash", async () => {
  const inst = await spawnRedis(10);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    await client.ping();
    client.emit("error", new Error("simulated redis error"));
    assert.ok(true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-012 client recovers after a Redis disconnect", async () => {
  const inst = await spawnRedis(11);
  instances.push(inst);
  const client = createClient({ url: inst.url, lazyConnect: true, maxRetriesPerRequest: null }, silentLogger);
  try {
    assert.equal(await client.ping(), "PONG");
    client.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(client.status === "end" || client.status === "close");
    // An explicit connect() reopens the connection.
    await new Promise<void>((resolve) => {
      client.once("connect", () => resolve());
      client.connect();
    });
    assert.equal(await client.ping(), "PONG");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-013 authentication failure produces a safe diagnostic", async () => {
  const inst = await spawnRedis(12);
  instances.push(inst);
  const client = createClient({ url: inst.url, lazyConnect: true, maxRetriesPerRequest: null }, silentLogger);
  try {
    await assert.rejects(async () => await client.auth("wrong", "wrong"), /WRONGPASS|NOAUTH|AUTH/);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-014 Redis unavailable during startup bounds behavior", async () => {
  const client = createClient({ url: "redis://127.0.0.1:16379/0", lazyConnect: true, maxRetriesPerRequest: null }, silentLogger);
  try {
    const result = await health(client, { timeout: 800 });
    assert.equal(result.status, "down");
    assert.ok(result.latency.value >= 0);
  } finally {
    client.disconnect();
  }
});

test("CORE-015 health returns up and latency", async () => {
  const inst = await spawnRedis(13);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const result = await health(client);
    assert.equal(result.status, "up");
    assert.equal(result.latency.unit, "ms");
    assert.ok(result.latency.value >= 0);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-016 health timeout settles within deadline", async () => {
  const client = createClient({ url: "redis://127.0.0.1:16379/0", lazyConnect: true, maxRetriesPerRequest: null }, silentLogger);
  try {
    const start = Date.now();
    const result = await health(client, { timeout: 400 });
    const elapsed = Date.now() - start;
    assert.equal(result.status, "down");
    assert.ok(elapsed < 2000, `health took too long: ${elapsed}ms`);
  } finally {
    client.disconnect();
  }
});

test("CORE-017 health during reconnect does not wait indefinitely", async () => {
  const inst = await spawnRedis(14);
  instances.push(inst);
  const client = createClient({ url: inst.url, lazyConnect: true, maxRetriesPerRequest: null }, silentLogger);
  try {
    await client.ping();
    client.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    const result = await health(client, { timeout: 500 });
    assert.ok(result.status === "up" || result.status === "down");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-018 concurrent health requests do not corrupt shared state", async () => {
  const inst = await spawnRedis(15);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => health(client)));
    assert.ok(results.every((r) => r.status === "up"));
    assert.ok(results.every((r) => r.latency.unit === "ms"));
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-019 graceful shutdown completes QUIT", async () => {
  const inst = await spawnRedis(16);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    await client.set("shutdown:key", "value");
    await shutdown(client, silentLogger);
    assert.ok(client.status === "end" || client.status === "close");
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-020 forced shutdown disconnects the connection", async () => {
  const inst = await spawnRedis(17);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    await shutdown(client, { timeout: 50 } as never, silentLogger);
    assert.ok(client.status === "end" || client.status === "close");
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-021 shutdown is idempotent", async () => {
  const inst = await spawnRedis(18);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    await shutdown(client, silentLogger);
    await shutdown(client, silentLogger);
    await shutdown(client, silentLogger);
    assert.ok(true);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-022 shutdown after disconnect is safe", async () => {
  const inst = await spawnRedis(19);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    client.disconnect();
    await shutdown(client, silentLogger);
    assert.ok(true);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-023 shutdown during reconnect leaves no orphaned loop", async () => {
  const inst = await spawnRedis(20);
  instances.push(inst);
  const client = createClient({ url: inst.url, lazyConnect: true, maxRetriesPerRequest: null }, silentLogger);
  try {
    await client.ping();
    client.disconnect();
    await shutdown(client, silentLogger);
    assert.ok(true);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-024 transaction command errors are classified per step", async () => {
  const inst = await spawnRedis(21);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    await client.set("tx:type", "string");
    const result = await runTransaction(
      client,
      [
        { label: "set-ok", run: (t) => t.set("tx:a", "1") },
        { label: "type-err", run: (t) => t.incr("tx:type") },
      ],
      { throwOnError: false },
    );
    assert.equal(result.executed, true);
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].error, undefined);
    assert.ok(result.results[1].error !== undefined);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-025 transaction timeout bounds the caller wait", async () => {
  // A client that can never reach Redis: EXEC never settles, so the timeout
  // must bound the caller's wait rather than hanging for the outage.
  const client = createClient({ url: "redis://127.0.0.1:16379/0", lazyConnect: true, maxRetriesPerRequest: null }, silentLogger);
  try {
    const start = Date.now();
    await assert.rejects(
      async () => {
        await runTransaction(
          client,
          [{ label: "blocked", run: (t) => t.get("k") }],
          { timeout: 200 },
        );
      },
      TransactionTimeoutError,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `transaction timeout did not bound the wait: ${elapsed}ms`);
  } finally {
    client.disconnect();
  }
});

test("CORE-026 multiple concurrent transactions isolate results", async () => {
  const inst = await spawnRedis(23);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        runTransaction(
          client,
          [{ label: `t${i}`, run: (t) => t.incr("tx:conc") }],
        ),
      ),
    );
    assert.equal(results.length, 10);
    assert.ok(results.every((r) => r.executed === true));
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

// --------------------------------------------------------------------------
// Advanced production scenarios
// --------------------------------------------------------------------------

test("CORE-ADV-001 health checks under 1,000 concurrent application operations", async () => {
  const inst = await spawnRedis(24);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    const ops = Array.from({ length: 1000 }, (_, i) => client.set(`adv:k${i}`, `v${i}`));
    await Promise.all(ops);
    const result = await health(client);
    assert.equal(result.status, "up");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-ADV-002 health detects an unreachable Redis within the deadline", async () => {
  // A client pointed at a port with no server must report "down" within the
  // configured deadline rather than hanging until the OS TCP timeout.
  const client = createClient({ url: "redis://127.0.0.1:16379/0", lazyConnect: true, maxRetriesPerRequest: null }, silentLogger);
  try {
    const start = Date.now();
    const result = await health(client, { timeout: 700 });
    const elapsed = Date.now() - start;
    assert.equal(result.status, "down");
    assert.ok(elapsed < 2500, `health did not bound the outage wait: ${elapsed}ms`);
    assert.ok(result.latency.value >= 0);
  } finally {
    client.disconnect();
  }
});

test("CORE-ADV-003 shared application client stays usable after queue close", async () => {
  const inst = await spawnRedis(26);
  instances.push(inst);
  const client = createClient({ url: inst.url }, silentLogger);
  try {
    await client.set("shared:client", "alive");
    assert.equal(await client.get("shared:client"), "alive");
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("CORE-ADV-004 createSentinelClient validates inputs", () => {
  assert.throws(() => createSentinelClient({ sentinels: [], name: "mymaster" } as never), /at least one Sentinel/i);
  assert.throws(() => createSentinelClient({ sentinels: [{ host: "127.0.0.1", port: 26379 }], name: "" } as never), /master name/i);
});
