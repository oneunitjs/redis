# @oneunit/redis

<p align="center">
  <img src="https://img.shields.io/npm/v/@oneunit/redis?style=flat-square&label=%40oneunit%2Fredis&color=dc382c" alt="npm version" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square" alt="Node.js ≥ 20" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/ESM-only-f7df1e?style=flat-square" alt="ESM only" />
</p>

<h1 align="center">@oneunit/redis</h1>

<p align="center">
  <strong>Redis client · BullMQ queues · Rate limiting · Distributed coordination · Caching · Resilience</strong><br/>
  A thin, opinionated integration layer over <a href="https://github.com/luin/ioredis">ioredis</a> and <a href="https://bullmq.io">BullMQ</a> for production Node.js services.
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-installation">Installation</a> ·
  <a href="#-usage-guides">Usage Guides</a> ·
  <a href="#-api-reference">API Reference</a> ·
  <a href="#-best-practices">Best Practices</a> ·
  <a href="#-troubleshooting">Troubleshooting</a>
</p>

---

## ✨ Why @oneunit/redis?

Working with Redis in production is deceptively hard. Raw ioredis gives you full power but zero guardrails — silent `localhost` fallbacks, unbounded reconnect loops, credential leaks in logs, no shutdown ordering, and copy-pasted rate-limiter code across every service.

`@oneunit/redis` solves all of that with **one install**:

| Problem | Solution |
|---|---|
| Silent connection to wrong host | `createClient()` **requires** a URL — throws if missing |
| Credentials in logs | `redactError()` strips passwords before they reach your logger |
| Unbounded reconnect loops | `maxRetriesPerRequest: null` default, BullMQ-compatible |
| Reinventing rate limiting | 4 algorithms, quotas, burst protection, concurrency — built-in |
| Distributed locking bugs | Fencing tokens, TTL expiry, auto-renewal — all handled |
| Redis outage = app down | Resilience engine: local fallback + write-journal + auto-recovery |
| Teardown that hangs | Bounded `shutdown()` with correct ordering |
| Importing unused code | Tree-shakeable subpath exports per module |

---

## 📋 Features

| Module | Import path | What you get |
|---|---|---|
| **Client** | `@oneunit/redis/client` | Connection factory, health checks, graceful shutdown, transactions, Sentinel/Cluster |
| **Queues & Workers** | `@oneunit/redis/queue` | BullMQ factories, shared connection, DLQ, job registry, middleware, flow producer |
| **Rate Limiting** | `@oneunit/redis/rate-limit` | Fixed window, sliding window, token bucket, leaky bucket, quotas, concurrency, burst |
| **Coordination** | `@oneunit/redis/coordination` | Distributed locks, semaphores, leader election, barriers, fencing tokens, single-flight |
| **Caching** | `@oneunit/redis/cache` | L1 in-process cache + Redis, write-behind, stale-while-revalidate, tag invalidation |
| **Resilience** | `@oneunit/redis/resilience` | Outage fallback, local write journal, auto-recovery |
| **Pipeline** | `@oneunit/redis/pipeline` | Bounded pipeline batching |
| **Auth Stores** | `@oneunit/redis/features` | Session, refresh-token, state stores with TTL |

---

## ⚡ Quick Start

### 1. Install

```bash
npm install @oneunit/redis
```

### 2. Start Redis

```bash
# Docker (recommended for local dev)
docker run -d --name redis -p 6379:6379 redis:alpine
```

### 3. Set your URL

```bash
export REDIS_URL="redis://127.0.0.1:6379"
```

### 4. Connect and use

```typescript
import { createClient, health, shutdown } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });

// Verify connection
const { status, latencyMs } = await health(redis);
console.log(`Redis is ${status} (${latencyMs}ms)`);

// Basic read/write — full ioredis API available
await redis.set("user:1", JSON.stringify({ name: "Alice" }), "EX", 3600);
const raw = await redis.get("user:1");
console.log(JSON.parse(raw!)); // { name: "Alice" }

// Always shut down gracefully
process.on("SIGTERM", () => shutdown(redis).then(() => process.exit(0)));
```

> **That's it.** No boilerplate, no silent `localhost` fallback, no credential leaks.

---

## 📦 Installation

```bash
npm install @oneunit/redis
```

**Requirements:**
- Node.js ≥ 20
- A running Redis instance (5.x, 6.x, or 7.x)
- `ioredis` and `bullmq` are **bundled** — no separate install needed
- `@oneunit/auth` is an **optional peer** (only if you use auth stores)

**Subpath imports** let you load only what you need:

```typescript
// Only loads the client — zero BullMQ overhead
import { createClient } from "@oneunit/redis/client";

// Only loads rate limiting
import { createRateLimiter } from "@oneunit/redis/rate-limit";

// Or import everything from the root (convenient for smaller projects)
import { createClient, createRateLimiter, createCoordinationClient } from "@oneunit/redis";
```

---

## 🗺️ Architecture Overview

```
Your Application
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│                    @oneunit/redis                        │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐ │
│  │  Client  │  │  Queue/  │  │    Rate Limiter /      │ │
│  │ createC  │  │  Worker  │  │   Coordination /       │ │
│  │  lient() │  │ (BullMQ) │  │   Cache / Resilience   │ │
│  └────┬─────┘  └────┬─────┘  └──────────┬────────────┘ │
│       │              │                   │               │
│       └──────────────┴───────────────────┘               │
│                       │                                  │
│              Shared Redis Connection                     │
│          (one client, many features)                     │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
                   Redis Server
            (Standalone / Sentinel / Cluster)
```

**Key design rule:** Create **one** `createClient()` instance and share it across all features. Each feature (rate limiter, cache, coordination, queue) accepts the same client.

---

## 📖 Usage Guides

### Redis Client

The foundation of everything. `createClient()` returns a native `ioredis` instance — you get the full ioredis API alongside the safety layer.

```typescript
import { createClient, health, shutdown } from "@oneunit/redis";

const redis = createClient({
  url: process.env.REDIS_URL, // falls back to REDIS_URL env var
  lazyConnect: true,          // (default) connects on first command
});

// Health check with timeout
const result = await health(redis, { timeout: 2000 });
// { status: "up", latencyMs: 1 }  or  { status: "down", error: "..." }

// Transactions (MULTI/EXEC)
import { runTransaction } from "@oneunit/redis";

const tx = await runTransaction(redis, [
  { label: "set-user",    run: (p) => p.set("user:1", "Alice") },
  { label: "set-session", run: (p) => p.set("session:abc", "1", "EX", 3600) },
]);
// tx.executed: true, tx.results: ["OK", "OK"]

// Sentinel (High Availability)
import { createSentinelClient } from "@oneunit/redis";

const ha = createSentinelClient({
  sentinels: [{ host: "sentinel1", port: 26379 }],
  name: "mymaster",
});

// Cluster
import { createClusterClient } from "@oneunit/redis";

const cluster = createClusterClient([
  { host: "node1", port: 7000 },
  { host: "node2", port: 7001 },
]);

// Graceful shutdown (safe to call multiple times)
await shutdown(redis, { timeout: 5000 });
```

**Shutdown order** (always do this in your SIGTERM handler):

```typescript
process.on("SIGTERM", async () => {
  await worker.close(true);    // 1. drain workers
  await queueEvents.close();   // 2. close event listeners
  await queue.close();         // 3. close queues
  await shutdown(redis);       // 4. close the client
  process.exit(0);
});
```

---

### Distributed Rate Limiting

Four algorithms. All backed by Lua scripts — atomically safe on a single Redis node.

#### Choose the right algorithm

| Algorithm | Best for | Trade-off |
|---|---|---|
| `fixed-window` | Simple throttling, low memory | 2× burst at window boundary |
| `sliding-window` | Strict per-user limits | Higher memory (sorted set per key) |
| `token-bucket` | Smooth traffic with burst allowance | More config knobs |
| `leaky-bucket` | Uniform output rate | Drops excess immediately |

#### Basic per-user limit (sliding window)

```typescript
import { createClient, createRateLimiter } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });

const limiter = createRateLimiter(redis, {
  algorithm: "sliding-window",
  limit: 100,           // 100 requests...
  intervalMs: 60_000,   // ...per minute
  keyPrefix: "api",     // namespace for Redis keys
  failurePolicy: "fail-open",  // allow requests if Redis is down
});

// In your request handler:
async function handler(userId: string) {
  const result = await limiter.consume(userId, 1);  // cost = 1 token

  if (!result.allowed) {
    return Response.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(result.retryAfterMs! / 1000)) },
      }
    );
  }

  return Response.json({ data: "..." });
}
```

#### Peek without consuming

```typescript
// Check without decrementing the counter
const peek = await limiter.check(userId, 1);
console.log(peek.remaining); // tokens left
```

#### Compose multiple limits (global + per-user)

```typescript
import { createMultiRateLimiter } from "@oneunit/redis";

const globalLimiter = createRateLimiter(redis, {
  algorithm: "fixed-window",
  limit: 10_000,
  intervalMs: 60_000,
  keyPrefix: "global",
});

const perUserLimiter = createRateLimiter(redis, {
  algorithm: "sliding-window",
  limit: 50,
  intervalMs: 60_000,
  keyPrefix: "user",
});

// Both must allow → request proceeds
const multi = createMultiRateLimiter([globalLimiter, perUserLimiter]);
const { allowed } = await multi.consume(userId, 1);
```

#### Concurrency limiter (max simultaneous requests)

```typescript
import { createConcurrencyLimiter } from "@oneunit/redis";

const concurrent = createConcurrencyLimiter(redis, {
  resource: "db-write",
  maxConcurrency: 10,  // only 10 requests at once
  leaseMs: 5000,       // auto-expires if worker crashes
  timeoutMs: 2000,     // wait up to 2s for a slot
});

const permit = await concurrent.acquire();
try {
  await writeToDatabase();
} finally {
  await permit.release();
}
```

#### Quota (daily/monthly caps)

```typescript
import { createQuota } from "@oneunit/redis";

const quota = createQuota(redis, {
  resource: "api-calls",
  quota: 10_000,    // 10k calls...
  period: "daily",  // ...per day (resets at UTC midnight)
});

const { allowed, remaining } = await quota.consume(userId, 1);
if (!allowed) return { error: "Daily quota exceeded", remaining: 0 };
```

#### Burst protection (sustained + spike)

```typescript
import { createBurstProtector } from "@oneunit/redis";

const burst = createBurstProtector(redis, {
  resource: "payment-api",
  sustainedLimit: 100,       // 100 req/min long-term
  sustainedIntervalMs: 60_000,
  burstCapacity: 20,         // allow 20-req spikes
  burstIntervalMs: 1_000,
  burstRefillRatePerSecond: 5,
  concurrencyLimit: 50,      // optional: max 50 in-flight
  concurrencyLeaseMs: 10_000,
});

const result = await burst.consume(userId);
```

---

### Distributed Coordination

#### Distributed lock (mutex)

Prevent two instances from running the same critical section simultaneously.

```typescript
import { createClient, createCoordinationClient } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });
const coord = createCoordinationClient(redis, { keyPrefix: "myapp:" });

// Option 1: withLock — automatic acquire + release
const lock = coord.lock("invoice:42");

const { acquired, result } = await lock.withLock(5000, async (handle) => {
  // handle.fencingToken — pass to downstream systems to detect stale holders
  // handle.leaseLost()  — check if TTL expired mid-operation
  await processInvoice(42, handle.fencingToken);
  return "done";
});

// Option 2: manual acquire/release
const acquired = await lock.tryAcquire({ leaseMs: 5000 });
if (acquired) {
  try {
    await criticalSection();
  } finally {
    await lock.release();
  }
}
```

> **In a Redis Cluster**, use hash tags so coordination keys land on the same slot:
> ```typescript
> coord.lock("{myapp}:invoice:42");
> ```

#### Semaphore (N concurrent slots)

```typescript
const sem = coord.semaphore("video-encoder");

const permit = await sem.acquire({ slots: 3, leaseMs: 30_000 }); // 3 concurrent encoders max
try {
  await encodeVideo();
} finally {
  await permit.release();
}
```

#### Leader election

```typescript
const leader = coord.leaderElection("scheduler-leader");

await leader.campaign({ termMs: 30_000 });

if (await leader.isLeader()) {
  // Only this instance runs the scheduled task
  await runCronJob();
}

leader.on("lost", () => {
  console.warn("Lost leadership — another instance took over");
});
```

#### Single-flight (deduplicate concurrent fetches)

```typescript
const sf = coord.singleFlight("user-fetch");

// If 50 requests arrive at once for user:42, only ONE hits the DB
const user = await sf.do("user:42", () => db.users.findById(42));
```

#### Distributed barrier

```typescript
const barrier = coord.barrier("batch-job", { count: 3 }); // wait for 3 workers

// In each of your 3 worker processes:
await barrier.arrive();
await barrier.wait(); // blocks until all 3 have arrived
console.log("All workers ready — starting batch");
```

---

### Caching

Two-layer cache: L1 (in-process `Map`) → L2 (Redis). Stampede protection built-in.

#### Basic read-through cache

```typescript
import { createClient, createRedisCache } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });

const cache = createRedisCache(redis, {
  defaultTtlSeconds: 300,       // 5-minute default TTL
  keyPrefix: "myapp:cache:",
});

// getOrLoad: returns cached value or calls loader (only once per key)
const user = await cache.getOrLoad(
  "user:42",
  async () => db.users.findById(42), // loader only called on cache miss
  { ttlSeconds: 600 }
);
```

#### L1 in-process cache (sub-millisecond hits)

```typescript
const cache = createRedisCache(redis, {
  defaultTtlSeconds: 300,
  localL1: {
    enabled: true,
    ttlSeconds: 60,          // keep in process memory for 60s
    sizePolicy: {
      maxEntries: 10_000,
      evictionPolicy: "lru", // "lru" | "lfu" | "fifo"
    },
  },
});
```

#### Stale-while-revalidate (SWR)

```typescript
const cache = createRedisCache(redis, {
  defaultTtlSeconds: 300,
  staleWhileRevalidate: true,  // serve stale instantly, refresh in background
  swrStaleSeconds: 60,         // serve stale data up to 60s after expiry
});

// First call after TTL: returns stale data immediately, refreshes in background
// Next call: returns fresh data
const data = await cache.getOrLoad("dashboard:metrics", fetchMetrics);
```

#### Tag-based invalidation

Invalidate all entries related to a user (across multiple keys) with one call:

```typescript
// Set with tags
await cache.set("user:42:profile", profileData, { tags: ["user:42"] });
await cache.set("user:42:settings", settingsData, { tags: ["user:42"] });
await cache.set("user:42:orders", ordersData, { tags: ["user:42"] });

// Invalidate everything tagged "user:42" at once
await cache.invalidateTag("user:42");
```

#### Write-behind (async writes)

```typescript
const cache = createRedisCache(redis, {
  defaultTtlSeconds: 300,
  writeBehind: {
    enabled: true,
    flushIntervalMs: 1000,  // flush dirty entries to Redis every 1s
    maxDirtyEntries: 100,
  },
});

// set() returns immediately; write to Redis happens asynchronously
await cache.set("counter:page-views", 9999);

// Always call shutdown to flush remaining dirty entries
await cache.shutdown();
```

#### Metrics

```typescript
const cache = createRedisCache(redis, {
  defaultTtlSeconds: 300,
  metrics: true,
});

// After some operations:
const stats = cache.metrics();
// { hits: 42, misses: 8, hitRate: 0.84, l1Hits: 35, l1HitRate: 0.72 }
```

---

### Job Queues (BullMQ)

#### Create a queue and add jobs

```typescript
import { createClient, createQueue, addJob, shutdown } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });

const emailQueue = createQueue({
  name: "emails",
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

// Enqueue a single job
const job = await addJob(emailQueue, "send-welcome", {
  to: "alice@example.com",
  template: "welcome",
});

// Enqueue multiple jobs at once
import { addBulkJobs } from "@oneunit/redis";

await addBulkJobs(emailQueue, [
  { name: "send-welcome", data: { to: "bob@example.com" } },
  { name: "send-welcome", data: { to: "carol@example.com" } },
]);
```

#### Create a worker to process jobs

```typescript
import { createWorker } from "@oneunit/redis";

const worker = createWorker({
  name: "emails",          // must match queue name
  connection: redis,
  concurrency: 5,
  processor: async (job) => {
    console.log(`Processing ${job.name}`, job.data);
    await sendEmail(job.data.to, job.data.template);
    return { sent: true };
  },
});

// Add middleware (logging, tracing, etc.)
import { createTracingMiddleware } from "@oneunit/redis";

worker.use(createTracingMiddleware({ serviceName: "email-service" }));
```

#### Schedule recurring jobs (cron)

```typescript
import { scheduleJob } from "@oneunit/redis";

// Run every day at 9am UTC
await scheduleJob(
  emailQueue,
  "daily-digest",
  { template: "daily-digest" },
  { pattern: "0 9 * * *", tz: "UTC" }
);
```

#### Dead-letter queue (DLQ)

```typescript
import { createDlqQueue, getDlqEntries } from "@oneunit/redis";

const dlq = createDlqQueue({
  queueName: "emails-dlq",
  connection: redis,
  preservePayload: true,
  sanitizeFields: ["password", "token"],  // strip sensitive fields
});

// Inspect failed jobs
const failed = await getDlqEntries(dlq, { limit: 10 });
failed.forEach((entry) => {
  console.log(entry.jobName, entry.failReason, entry.payload);
});
```

#### Listen for queue events

```typescript
import { attachQueueEvents } from "@oneunit/redis";

const events = attachQueueEvents({
  queue: emailQueue,
  connection: redis,
});

events.on("completed", ({ jobId, returnvalue }) => {
  console.log(`Job ${jobId} done:`, returnvalue);
});

events.on("failed", ({ jobId, failedReason }) => {
  console.error(`Job ${jobId} failed:`, failedReason);
});

events.on("stalled", ({ jobId }) => {
  console.warn(`Job ${jobId} stalled`);
});
```

---

### At-Least-Once Job Processing

Convenience wrapper that bundles BullMQ queue + worker on a **single shared client**. Ideal for microservices that need reliable job delivery without managing queue/worker instances separately.

```typescript
import { createClient } from "@oneunit/redis";

const redis = createClient({
  url: process.env.REDIS_URL,
  jobAtLeastOnce: {
    enabled: true,
    queueName: "app-jobs",
    concurrency: 10,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    dlq: {
      queueName: "app-jobs-dlq",
      preservePayload: true,
      sanitizeFields: ["password", "secret"],
    },
  },
});

// Register your processors
const worker = redis.jobAtLeastOnce.createWorker(async (job) => {
  switch (job.name) {
    case "send-email": await sendEmail(job.data); break;
    case "resize-image": await resizeImage(job.data); break;
  }
  return { success: true };
});

// Enqueue jobs from anywhere that has access to `redis`
await redis.jobAtLeastOnce.add("send-email", { to: "alice@example.com" });
await redis.jobAtLeastOnce.add("resize-image", { imageId: "img_123" });

// Schedule a recurring job
await redis.jobAtLeastOnce.schedule(
  "cleanup",
  { olderThanDays: 30 },
  { pattern: "0 2 * * *" } // 2am daily
);

// Shut down (closes worker + queue)
await redis.jobAtLeastOnce.close();
await shutdown(redis);
```

---

### Pipeline Batching

Execute multiple Redis commands in one round-trip with bounded timeout and per-command error reporting.

```typescript
import { createClient, runPipeline, pipelineValues } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });

const results = await runPipeline(redis, [
  { label: "get-user",    run: (p) => p.get("user:1") },
  { label: "get-session", run: (p) => p.get("session:abc") },
  { label: "get-config",  run: (p) => p.hgetall("config:app") },
], { timeout: 3000 });

// A failed step does NOT abort the whole batch
const [user, session, config] = pipelineValues(results);
```

---

### Resilience Engine

Keep your app alive during Redis outages. The engine buffers writes locally and replays them when Redis recovers.

```typescript
import { createClient } from "@oneunit/redis";

const redis = createClient({
  url: process.env.REDIS_URL,
  resilience: {
    fallback: {
      enabled: true,
      maxOperations: 5000,      // buffer up to 5k ops during outage
      maxPayloadBytes: 10_000_000, // 10 MiB max buffer
    },
    recovery: {
      enabled: true,
      autoRecover: true,        // replay automatically when Redis reconnects
      recoveryBatchSize: 100,
    },
  },
});

// During a Redis outage:
await redis.set("session:abc", "data");  // → BUFFERED locally, not lost
const val = await redis.get("session:abc"); // → served from local store

// When Redis comes back → all buffered writes are replayed automatically
```

**Supported operations during outage:**

| Category | Commands |
|---|---|
| **Reads** (served from local store) | `get`, `exists`, `ttl`, `hget`, `smembers` |
| **Writes** (buffered for replay) | `set`, `setex`, `setnx`, `del`, `expire`, `sadd`, `srem`, `hset`, `hdel`, `getset` |
| **Never buffered** | `incr`/`decr`, locks, transactions, Lua scripts |

**Operation outcomes:**

| Outcome | Meaning |
|---|---|
| `EXECUTED` | Ran against Redis normally |
| `BUFFERED` | Stored locally, will replay on recovery |
| `REJECTED` | Buffer full or operation not eligible |
| `AMBIGUOUS` | May have executed — handle at application layer |
| `EXPIRED` | Deadline passed before execution |
| `FAILED` | Permanent failure after max retries |

> ⚠️ **Important:** Resilience is process-local — each instance maintains its own buffer. It is not a substitute for Redis replication or cross-instance coordination.

---

### Auth Stores

Ready-made session, refresh-token, and state stores for authentication flows.

```typescript
import { createClient, createRedisStores } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });

const { session, refresh, state } = createRedisStores(redis, {
  keyPrefix: "myapp:auth:",
});

// — Session store —
// Track per-user session version (bump = invalidate all existing JWTs)
const version = await session.bumpVersion(userId);
await session.revokeSession(sessionId);
const isRevoked = await session.isSessionRevoked(sessionId);

// — Refresh token store —
await refresh.save({
  id: "token_xyz",
  userId: 42,
  tokenHash: hash(refreshToken),
  expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
});

// Atomic consume: get + delete in one operation (prevents double-use)
const record = await refresh.consume("token_xyz");

// — State store (OAuth state, password-reset tokens, magic links) —
await state.set("oauth_state_abc", { redirectUrl: "/dashboard" }, 300); // 5 min TTL
const oauthState = await state.consume("oauth_state_abc"); // get + delete atomically
```

---

### Error Handling & Security

```typescript
import { redactError, classifyError, isRetryable } from "@oneunit/redis";

try {
  await redis.set("key", "value");
} catch (err) {
  // Strip passwords/tokens before logging
  const safe = redactError(err);
  logger.error("Redis error", { error: safe.message });

  // Classify the error
  const { type, retryable } = classifyError(err);
  // type: "connection" | "timeout" | "command" | "auth" | "unknown"

  if (isRetryable(err)) {
    // schedule a retry
  }
}
```

---

## 🔌 Complete Example

A realistic Express API with rate limiting, caching, and a job queue — all sharing one Redis client.

```typescript
import express from "express";
import {
  createClient,
  createRateLimiter,
  createRedisCache,
  createQueue,
  createWorker,
  addJob,
  health,
  shutdown,
} from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });

// Rate limiter: 60 requests per minute per IP
const limiter = createRateLimiter(redis, {
  algorithm: "sliding-window",
  limit: 60,
  intervalMs: 60_000,
  keyPrefix: "api:rate",
});

// Cache with L1 layer
const cache = createRedisCache(redis, {
  defaultTtlSeconds: 300,
  localL1: { enabled: true, ttlSeconds: 30 },
  staleWhileRevalidate: true,
});

// Background job queue
const emailQueue = createQueue({ name: "emails", connection: redis });
const emailWorker = createWorker({
  name: "emails",
  connection: redis,
  concurrency: 5,
  processor: async (job) => sendEmail(job.data),
});

const app = express();

// Rate limiting middleware
app.use(async (req, res, next) => {
  const { allowed, retryAfterMs } = await limiter.consume(req.ip, 1);
  if (!allowed) {
    return res.status(429).json({
      error: "Too many requests",
      retryAfter: Math.ceil(retryAfterMs! / 1000),
    });
  }
  next();
});

// Cached endpoint
app.get("/users/:id", async (req, res) => {
  const user = await cache.getOrLoad(
    `user:${req.params.id}`,
    () => db.users.findById(req.params.id)
  );
  res.json(user);
});

// Enqueue a job
app.post("/users/:id/welcome-email", async (req, res) => {
  await addJob(emailQueue, "send-welcome", {
    userId: req.params.id,
    to: req.body.email,
  });
  res.json({ queued: true });
});

// Health endpoint
app.get("/health", async (req, res) => {
  const result = await health(redis);
  res.status(result.status === "up" ? 200 : 503).json(result);
});

const server = app.listen(3000);

// Graceful shutdown
process.on("SIGTERM", async () => {
  server.close();
  await emailWorker.close(true);  // drain jobs
  await emailQueue.close();
  await cache.shutdown();
  await shutdown(redis);
  process.exit(0);
});
```

---

## 📚 API Reference

### `createClient(urlOrOptions, logger?)`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | `process.env.REDIS_URL` | Redis URL (`redis://...` or `rediss://...` for TLS) |
| `lazyConnect` | `boolean` | `true` | Defer TCP connection until first command |
| `maxRetriesPerRequest` | `number \| null` | `null` | Per-request retries. `null` = BullMQ-compatible |
| `resilience` | `ResilientRedisOptions` | — | Enable outage fallback/recovery |
| `jobAtLeastOnce` | `boolean \| JobAtLeastOnceOptions` | `false` | Enable at-least-once job processing |
| `logger` | `Logger` | no-op | `{ error, warn, info, debug }` compatible logger |

**Returns:** `Redis` (ioredis instance) or `Redis & ResilientRedisFacade` if resilience is enabled.

---

### `health(client, options?)`

```typescript
const { status, latencyMs, error } = await health(redis, { timeout: 1000 });
// status: "up" | "down"
```

---

### `shutdown(client, options?)`

Idempotent — safe to call multiple times. Sends `QUIT`, waits up to `timeout` ms, then forces disconnect.

```typescript
await shutdown(redis, { timeout: 5000 });
```

---

### `createRateLimiter(redis, options)`

| Field | Type | Description |
|---|---|---|
| `algorithm` | `"fixed-window" \| "sliding-window" \| "token-bucket" \| "leaky-bucket"` | Limiting algorithm |
| `limit` | `number` | Max requests per interval (or bucket capacity) |
| `intervalMs` | `number` | Window duration in ms |
| `keyPrefix` | `string` | Redis key namespace |
| `failurePolicy` | `"fail-open" \| "fail-closed"` | Behavior when Redis is unreachable. Default: `"fail-closed"` |

**Instance methods:**
- `limiter.consume(key, cost?)` → `{ allowed, remaining, retryAfterMs }`
- `limiter.check(key, cost?)` → peek without consuming

---

### `createCoordinationClient(redis, options?)`

| Field | Type | Description |
|---|---|---|
| `keyPrefix` | `string` | Namespace all coordination keys |

**Returns a client with:**

| Method | Returns | Description |
|---|---|---|
| `.lock(resource)` | `LockManager` | Distributed mutex |
| `.semaphore(resource)` | `SemaphoreManager` | N-slot counting semaphore |
| `.leaderElection(resource)` | `LeaderElection` | Term-based leadership |
| `.singletonScheduler(resource)` | `SingletonScheduler` | One-owner periodic task |
| `.jobClaim(jobId)` | `JobClaim` | At-least-once claim/complete/release |
| `.barrier(resource, options)` | `Barrier` | Arrive-and-wait synchronization |
| `.fencing(resource)` | `FencingManager` | Monotonic token management |
| `.singleFlight(resource)` | `SingleFlight` | Deduplicate concurrent executions |

---

### `createRedisCache(redis, options?)`

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultTtlSeconds` | `number` | `300` | Default TTL for cache entries |
| `keyPrefix` | `string` | `"oneunit:cache:"` | Redis key prefix |
| `localL1.enabled` | `boolean` | `false` | Enable in-process cache layer |
| `localL1.ttlSeconds` | `number` | `60` | L1 TTL |
| `localL1.sizePolicy.maxEntries` | `number` | `10000` | Max L1 entries |
| `localL1.sizePolicy.evictionPolicy` | `"lru" \| "lfu" \| "fifo"` | `"lru"` | L1 eviction |
| `writeBehind.enabled` | `boolean` | `false` | Enable async writes |
| `writeBehind.flushIntervalMs` | `number` | `1000` | Flush interval |
| `staleWhileRevalidate` | `boolean` | `false` | SWR mode |
| `negativeTtlSeconds` | `number` | — | Cache `null` results for this long |
| `metrics` | `boolean` | `false` | Track hit/miss stats |

**Instance methods:**
- `cache.get(key)` → `T | null`
- `cache.set(key, value, options?)` → stores with optional TTL and tags
- `cache.getOrLoad(key, loader, options?)` → read-through with stampede protection
- `cache.invalidate(key)` → remove single entry
- `cache.invalidateTag(tag)` → remove all entries with this tag
- `cache.metrics()` → `CacheMetrics`
- `cache.shutdown()` → flush write-behind buffer

---

### `createQueue(config)` / `createWorker(config)`

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Queue/worker name (must match between queue and worker) |
| `connection` | `Redis` | Shared ioredis client |
| `prefix` | `string` | Redis key prefix. Default: `"queue"` |
| `defaultJobOptions` | `JobsOptions` | Retry/backoff/retention defaults |
| `concurrency` | `number` | (Worker only) Max concurrent jobs |
| `middleware` | `JobMiddleware[]` | (Worker only) Middleware chain |

---

### `createResilientRedis(client, options)`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Disable for pass-through |
| `maxOperations` | `number` | `10000` | Max journal entries during outage |
| `maxPayloadBytes` | `number` | `52_428_800` (50 MiB) | Max buffer memory |
| `maxRetries` | `number` | `3` | Max recovery replay attempts |
| `conflictPolicy` | `"overwrite" \| "reject" \| "abort"` | `"overwrite"` | Recovery conflict resolution |
| `autoRecover` | `boolean` | `false` | Replay buffer when Redis reconnects |

---

### Core Helpers

```typescript
import { buildKey, serialize, deserialize, compareAndSwap, setIfAbsent, jitterTtl } from "@oneunit/redis";

// Safe key builder — throws on empty segments
const key = buildKey("user", userId, "settings");   // "user:42:settings"

// JSON codec
const encoded = serialize({ name: "Alice" });       // string
const decoded = deserialize<User>(encoded);          // User object

// Optimistic CAS (compare-and-swap)
const success = await compareAndSwap(redis, "config:version", "v1", "v2");

// Atomic write gate (SET NX)
const written = await setIfAbsent(redis, "lock:key", "owner", { ttlSeconds: 30 });

// TTL jitter (prevent cache stampede)
const ttl = jitterTtl(300, 0.1);  // 300s ± 10% random jitter
```

---

## 🏆 Best Practices

### Connection

```typescript
// ✅ One client, shared everywhere
const redis = createClient({ url: process.env.REDIS_URL });
const limiter = createRateLimiter(redis, { ... });
const cache   = createRedisCache(redis, { ... });
const queue   = createQueue({ name: "jobs", connection: redis });

// ❌ Don't create a new client per feature
const redisForCache = createClient({ url: ... });
const redisForQueue = createClient({ url: ... });
```

### Shutdown

```typescript
// ✅ Always implement SIGTERM handling in correct order
process.on("SIGTERM", async () => {
  await worker.close(true);    // 1. drain workers first
  await queueEvents.close();   // 2. then event listeners
  await queue.close();         // 3. then queues
  await cache.shutdown();      // 4. flush write-behind
  await shutdown(redis);       // 5. close client last
  process.exit(0);
});
```

### Security

```typescript
// ✅ Credentials via env var
const redis = createClient({ url: process.env.REDIS_URL });

// ✅ Redact before logging
logger.error("Redis failed", { error: redactError(err).message });

// ✅ TLS in production
const redis = createClient({ url: "rediss://host:6380" }); // rediss:// = TLS

// ❌ Never hardcode credentials
const redis = createClient({ url: "redis://:mypassword@host:6379" }); // hardcoded!
```

### Rate Limiting

| Scenario | Recommendation |
|---|---|
| Public API (strict per-user) | `sliding-window` |
| Internal service (simple) | `fixed-window` |
| Variable-cost operations | `token-bucket` with cost parameter |
| Uniform output rate required | `leaky-bucket` |
| Multi-tier limits needed | `createMultiRateLimiter` |
| Strict in-flight cap | `createConcurrencyLimiter` |
| Calendar-based budget | `createQuota` |

### Caching

- **Enable L1** (`localL1.enabled: true`) for hot read paths — reduces Redis round-trips to zero
- **Use tag invalidation** instead of `invalidate(key)` per-entry when you need group invalidation
- **Enable SWR** for read-heavy data that can be slightly stale (dashboards, catalogs)
- **Set `negativeTtlSeconds`** to cache "not found" results and prevent repeated DB lookups

### Queues

- Set `removeOnComplete: 100` and `removeOnFail: 500` to prevent unbounded job growth
- Match `concurrency` to downstream capacity, not CPU core count
- Always configure a DLQ for jobs that need manual inspection after all retries
- Use `scheduleJob` for recurring work instead of an external cron

---

## 🐛 Troubleshooting

### `Error: No Redis URL provided`

**Cause:** `REDIS_URL` env var is not set and no `url` was passed.

```bash
export REDIS_URL="redis://127.0.0.1:6379"
```

or:
```typescript
const redis = createClient({ url: "redis://127.0.0.1:6379" });
```

---

### `ECONNREFUSED`

**Cause:** Redis is not running at the configured address.

```bash
# Start Redis locally
docker run -d -p 6379:6379 redis:alpine

# Verify it's up
redis-cli ping  # → PONG
```

---

### Worker not processing jobs

1. Verify `name` is identical between `createQueue` and `createWorker`
2. Verify `prefix` matches between queue and worker
3. Check `worker.isRunning()` returns `true`
4. Listen to worker events: `worker.on("failed", (job, err) => console.error(err))`

---

### `CROSSSLOT` error in Redis Cluster

Coordination keys span multiple hash slots. Use hash tags:

```typescript
// ✅ Hash tag forces all keys for this resource onto the same slot
coord.lock("{myapp:invoice:42}:lock");

// ❌ No hash tag — may cross slots
coord.lock("invoice:42");
```

---

### `"Connection is closed."` unhandled rejection

This is a benign BullMQ behavior. The package patches `Redis.prototype.connect` to absorb it. Ensure you are on the latest version of `@oneunit/redis`.

---

### Resilience buffers but never replays

Enable `autoRecover` or trigger manually:

```typescript
// Auto-replay when Redis reconnects
const redis = createClient({
  url: process.env.REDIS_URL,
  resilience: {
    recovery: { enabled: true, autoRecover: true },
  },
});

// Or trigger manually
await redis.recover();
```

---

### `keyPrefix` throws on createClient

ioredis's `keyPrefix` option is incompatible with BullMQ. Use the `prefix` option on queues/workers/coordination instead — never on the client itself.

```typescript
// ❌ Breaks BullMQ
createClient({ url: "...", keyPrefix: "app:" });

// ✅ Set prefix per feature
createQueue({ name: "jobs", connection: redis, prefix: "app" });
createCoordinationClient(redis, { keyPrefix: "app:" });
```

---

## 📂 Documentation Index

| Document | Contents |
|---|---|
| **README.md** | This file — getting started, usage guides, API reference |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design principles, structural diagrams, ownership contracts |
| [docs/client/README.md](docs/client/README.md) | Full client API — `createClient`, health, shutdown, transactions |
| [docs/queue/README.md](docs/queue/README.md) | BullMQ factories, job lifecycle, DLQ, flow producer |
| [docs/pipeline/README.md](docs/pipeline/README.md) | Pipeline batching |
| [docs/rate-limit/README.md](docs/rate-limit/README.md) | Rate limiting algorithms in depth |
| [docs/coordination/README.md](docs/coordination/README.md) | Locks, semaphores, leader election, barriers |
| [docs/cache/README.md](docs/cache/README.md) | L1/L2 cache, write-behind, SWR, tag invalidation |
| [docs/resilience/README.md](docs/resilience/README.md) | Resilience engine — outage fallback, recovery |
| [docs/features/README.md](docs/features/README.md) | Auth stores — session, refresh-token, state |
| [docs/jobs/README.md](docs/jobs/README.md) | At-least-once job processing |

---

## 💬 Glossary

| Term | Definition |
|---|---|
| **L1 cache** | In-process, in-memory cache (sub-ms) sitting in front of Redis |
| **Write-behind** | Write to local store immediately, flush to Redis asynchronously |
| **Stale-while-revalidate (SWR)** | Serve stale data instantly while refreshing in the background |
| **Fencing token** | Monotonically increasing number to detect stale lock holders |
| **At-least-once** | Delivery guarantee: a job is processed ≥ once (duplicates possible) |
| **AMBIGUOUS** | Resilience outcome: Redis may have executed — do not blind-replay |
| **Lazy connect** | TCP connection deferred until the first Redis command |
| **Subpath import** | `@oneunit/redis/cache` loads only the cache module, not the whole package |
| **Stampede protection** | Ensuring only one loader runs for a cache key even under concurrent misses |

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built with ❤️ by <a href="https://github.com/oneunitjs">oneunitjs</a> ·
  <a href="https://github.com/oneunitjs/redis">GitHub</a> ·
  <a href="https://github.com/oneunitjs/redis/issues">Issues</a>
</p>
