<p align="center">
  <strong>@oneunit/redis</strong>
  <br/>
  Redis client, BullMQ job queues, distributed rate limiting, coordination, caching & resilience for Node.js
</p>

<p align="center">
  npm version · license · node version · types included
</p>

---

# User Manual — `@oneunit/redis`

This manual walks you through installing, configuring, and using every feature of `@oneunit/redis` (codename **machism**). It is written for end-users integrating Redis into Node.js applications.

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Installation Guide](#2-installation-guide)
3. [Core Concepts](#3-core-concepts)
4. [API Reference — Redis Client](#4-api-reference-redis-client)
5. [API Reference — Queues & Workers](#5-api-reference-queues--workers)
6. [API Reference — Pipeline Batching](#6-api-reference-pipeline-batching)
7. [API Reference — Distributed Rate Limiting](#7-api-reference-distributed-rate-limiting)
8. [API Reference — Distributed Coordination](#8-api-reference-distributed-coordination)
9. [API Reference — Caching](#9-api-reference-caching)
10. [API Reference — Resilience Engine](#10-api-reference-resilience-engine)
11. [API Reference — At-Least-Once Jobs](#11-api-reference-at-least-once-jobs)
12. [API Reference — Auth Stores & Core Helpers](#12-api-reference-auth-stores--core-helpers)
13. [Parameter Specifications](#13-parameter-specifications)
14. [Usage Examples](#14-usage-examples)
15. [Troubleshooting & FAQ](#15-troubleshooting--faq)
16. [Optimization & Best Practices](#16-optimization--best-practices)
17. [Glossary](#17-glossary)
18. [Documentation Index](#18-documentation-index)
19. [License](#19-license)

---

## 1. Project Overview

### What is @oneunit/redis?

`@oneunit/redis` (codename **machism**) is a thin, opinionated integration layer over **ioredis** (a robust Redis client for Node.js) and **BullMQ** (a Redis-backed job queue library). The package does not replace these libraries — it returns native `ioredis` and `BullMQ` objects unchanged. Instead, it adds safe defaults, explicit contracts, bounded operations, and modular, independently loadable subsystems.

### Core Functionality

| Area | What it provides |
|---|---|
| Redis client | Connection factory, health checks, shutdown, transactions, Sentinel/Cluster support |
| Queues & workers | BullMQ queue and worker factories, shared connections, DLQ, flow producer |
| Pipeline | Bounded batching of Redis commands |
| Rate limiting | Fixed window, sliding window, token bucket, leaky bucket, quotas, concurrency, burst |
| Coordination | Distributed locks, semaphores, leases, leader election, barriers, fencing |
| Caching | L1 in-process cache, Redis layer, write-behind, stale-while-revalidate, tag invalidation |
| Resilience | Outage fallback, local buffering, TTL-preserving recovery |
| Jobs | Optional at-least-once BullMQ job processing |
| Auth stores | Session, refresh-token, and state stores with TTL |

### Intended Use Cases

- Micro-services that need reliable Redis connectivity without reinventing safety checks.
- Distributed systems requiring rate-limiting, distributed locks, leader election, or job queues.
- Applications that must survive temporary Redis outages gracefully (resilience engine).
- Teams that want credential safety, bounded deadlines, and clear ownership contracts in their Redis code.

---

## 2. Installation Guide

### Step 1 — Install from npm

```bash
npm install @oneunit/redis
```

`ioredis` and `bullmq` are bundled dependencies. `@oneunit/auth` is an optional peer dependency (only needed if you use auth stores).

### Step 2 — Set up a Redis instance

You need access to a Redis server. Common options:

- **Local development:** install Redis via Docker or your OS package manager.
- **Cloud:** Redis Cloud, AWS ElastiCache, Azure Cache for Redis, etc.
- **Docker:** `docker run -d --name redis -p 6379:6379 redis:alpine`

You will need the Redis connection URL, typically in the form:

```
redis://[:password@]host:port[/db]
```

### Step 3 — Configure the URL

Set the `REDIS_URL` environment variable:

```bash
export REDIS_URL="redis://127.0.0.1:6379"
```

Or pass it directly when creating a client (see Section 4).

### Step 4 — Verify installation

Create a small test file `test-connection.ts`:

```typescript
import { createClient, health, shutdown } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });

await health(redis, { timeout: 1000 });
console.log("Redis is reachable.");

await shutdown(redis);
```

Run it:

```bash
npx tsx test-connection.ts
```

You should see `Redis is reachable.`

---

## 3. Core Concepts

### Explicit URL

`createClient()` requires a Redis URL (via argument or `REDIS_URL` environment variable). It never silently connects to `localhost:6379`.

### Lazy connect

By default, `lazyConnect: true` defers the actual TCP connection until the first command. This keeps cold-start latency low and avoids import-time side effects.

### Subpath imports

Import only the subsystems you need:

```typescript
import { createClient } from "@oneunit/redis/client";
import { createRateLimiter } from "@oneunit/redis/rate-limit";
import { createCoordinationClient } from "@oneunit/redis/coordination";
import { createRedisCache } from "@oneunit/redis/cache";
```

This keeps your bundle small and avoids pulling in BullMQ unless you use queues or jobs.

### Ownership

Every resource has a documented owner:

| Factory | Owned by | Closed by |
|---|---|---|
| `createClient()` | Application | `shutdown()` |
| `createQueue()` / `createWorker()` | Caller | `queue.close()` / `worker.close()` |
| `attachQueueEvents()` | Caller | `events.close()` |
| `createResilientRedis()` | Caller | `shutdown()` |

Always close resources in order during shutdown: workers → QueueEvents → queues → client.

---

## 4. API Reference — Redis Client

### `createClient(urlOrOptions, logger?)`

Creates a native `ioredis` client with safe defaults.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `urlOrOptions` | `string` or `RedisClientOptions` | Yes | — | Redis URL string, or an options object with `url`, `lazyConnect`, etc. |
| `logger` | `Logger` | No | no-op | Optional logger with `{ error, warn, info, debug }` methods. |

#### Options object fields

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | `process.env.REDIS_URL` | Redis connection URL. Required if no positional string given. |
| `lazyConnect` | `boolean` | `true` | Defer connection until first command. |
| `maxRetriesPerRequest` | `number \| null` | `null` | `null` disables per-request retries (BullMQ-compatible). |
| `resilience` | `ResilientRedisOptions` | — | Enables outage fallback/recovery. |
| `jobAtLeastOnce` | `boolean \| JobAtLeastOnceOptions` | `false` | Enables optional at-least-once job processing. |
| `ownsClient` / `shutdownClient` | `boolean` | — | Whether `shutdown()` closes the underlying client. |

**Returns:** A native `Redis` instance, or `Redis & ResilientRedisFacade` if resilience is enabled.

### `health(client, options)`

Performs a bounded `PING` and returns status + latency.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `client` | `Redis` | — | The client to check. |
| `options.timeout` | `number` | `1000` ms | Maximum time to wait for the PING. Invalid/negative values fall back to 1000 ms. |

**Returns:** `{ status: "up" \| "down", latencyMs: number, error?: string }`. The promise always settles within the deadline.

### `shutdown(client, options)`

Idempotent graceful shutdown. Safe to call multiple times.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `client` | `Redis` | — | The client to shut down. |
| `options.timeout` | `number` | `5000` ms | Max time to wait for `QUIT` before forcing disconnect. |
| `options.logger` | `Logger` | — | Optional logger for warnings. |

### `runTransaction(redis, steps, options)`

Wraps `MULTI`/`EXEC` with typed steps, bounded timeout, and credential redaction.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `redis` | `Redis` | — | Target client. |
| `steps` | `TransactionStep[]` | — | Array of `{ label, run }` pairs. Each `run` must queue exactly one command. |
| `options.timeout` | `number` | `5000` ms | Max time to wait for `EXEC`. |
| `options.watch` | `string[]` | — | Keys to `WATCH` before `MULTI`. |
| `options.throwOnError` | `boolean` | — | Whether step failures throw. |
| `options.logger` | `Logger` | — | Optional logger. |

**Returns:** `{ executed: boolean, results: unknown[], durationMs: number, failed: number }`.

### `attachEvents(client)`

Attaches ioredis lifecycle event handlers (`connect`, `ready`, `reconnecting`, `error`, `close`).

### `attachErrorHandling(client, options)`

Attaches typed error classification and retry policies.

### `redactError(error)`

Strips passwords/tokens from error messages before logging or re-throwing.

### `createSentinelClient(options)`

Creates a Sentinel-backed client. Pass-through to ioredis Sentinel options.

### `createClusterClient(nodes, options)`

Creates an ioredis Cluster client. See Section 16 for cluster key design rules.

---

## 5. API Reference — Queues & Workers

### `createQueue(config)`

Creates a BullMQ `Queue` with a shared connection.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | Yes | — | Queue name. |
| `connection` | `Redis` | Yes | — | Shared ioredis client. |
| `prefix` | `string` | No | `'queue'` | Redis key prefix. |
| `defaultJobOptions` | `JobsOptions` | No | see below | Defaults applied to all jobs. |
| `settings` | `QueueOptions["settings"]` | No | — | BullMQ queue settings. |

**Default job options:** `removeOnComplete: 100`, `removeOnFail: 1000`, `attempts: 3`, `backoff: { type: "exponential", delay: 1000 }`.

### `createWorker(config)`

Creates a BullMQ `Worker` with optional middleware chaining.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | Yes | — | Worker name (must match queue name). |
| `processor` | `Processor` | Yes | — | Job processing function `(job) => Promise<TResult>`. |
| `connection` | `Redis` | Yes | — | Shared ioredis client. |
| `prefix` | `string` | No | `'queue'` | Redis key prefix. |
| `concurrency` | `number` | No | — | Max concurrent jobs. |
| `limiter` | `WorkerOptions["limiter"]` | No | — | Job rate limiter. |
| `middleware` | `JobMiddleware[]` | No | `[]` | Middleware chain. |

**Returns:** `WorkerWithMiddleware` supporting `.use(middleware)` chaining.

### `attachQueueEvents(config)`

Listens for BullMQ queue events (completed, failed, stalled, etc.).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `queue` | `Queue` | Yes | — | The queue to observe. |
| `prefix` | `string` | No | `'queue'` | Redis key prefix (inherits from queue). |
| `connection` | `Redis` | Yes | — | Shared ioredis client. |
| `logger` | `Logger` | No | — | Optional logger. |

**Returns:** `ManagedQueueEvents` — disconnects duplicated clients before `close()` to prevent orphaned reconnect loops.

---

## 6. API Reference — Pipeline Batching

### `runPipeline(redis, steps, options)`

Executes one Redis command per step with bounded execution and per-command error reporting.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `redis` | `Redis` | — | Target client. |
| `steps` | `PipelineStep[]` | — | Each step queues exactly one command. |
| `options.timeout` | `number` | `5000` ms | Max wait time. |
| `options.logger` | `Logger` | — | Optional logger. |

**Returns:** Per-command results with individual error handling — a failed step does not abort the whole batch.

### `pipelineValues(steps)`

Extracts typed values from pipeline results.

---

## 7. API Reference — Distributed Rate Limiting

### `createRateLimiter(client, options)`

Creates a rate limiter for one of four algorithms.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `algorithm` | `"fixed-window" \| "sliding-window" \| "token-bucket" \| "leaky-bucket"` | Yes | — | Limiting algorithm. |
| `limit` | `number` | Yes | — | Max requests per window (window algorithms) or capacity (bucket algorithms). |
| `intervalMs` | `number` | Yes | — | Window size in milliseconds. |
| `keyPrefix` | `string` | No | — | Optional key namespace. |
| `failurePolicy` | `"fail-open" \| "fail-closed"` | No | `"fail-closed"` | Behavior when Redis is unavailable. |

**Returns:** Limiter with `.consume(key, cost)` and `.check(key, cost)` methods.

### `createMultiRateLimiter(limiters)`

Composes multiple limiters; all must allow for a request to proceed.

| Parameter | Type | Description |
|---|---|---|
| `limiters` | `RateLimiter[]` | Array of independent limiters. |

### `createConcurrencyLimiter(client, options)`

Distributed semaphore for limiting concurrent operations.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `resource` | `string` | Yes | — | Resource name. |
| `maxConcurrency` | `number` | Yes | — | Max simultaneous permits. |
| `leaseMs` | `number` | Yes | — | Lease duration (auto-expires). |
| `timeoutMs` | `number` | No | — | Max wait for a permit. |
| `retryIntervalMs` | `number` | No | — | Poll interval. |

### `createQuota(client, options)`

Calendar-based quotas (daily, monthly, or custom period).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `resource` | `string` | Yes | — | Resource name. |
| `quota` | `number` | Yes | — | Max consumption per period. |
| `period` | `"daily" \| "monthly" \| "custom"` | Yes | — | Reset period. |
| `customPeriodMs` | `number` | No | — | Required if `period: "custom"`. |
| `weight` | `number` | No | `1` | Consumption weight per call. |

### `createBurstProtector(client, options)`

Multi-layer protection combining sustained limit, burst allowance, and optional concurrency.

| Field | Type | Description |
|---|---|---|
| `sustainedLimit` | `number` | Long-term requests per window. |
| `sustainedIntervalMs` | `number` | Sustained window size. |
| `burstCapacity` | `number` | Short-term burst token capacity. |
| `burstIntervalMs` | `number` | Burst refill window. |
| `burstRefillRatePerSecond` | `number` | Burst refill rate. |
| `concurrencyLimit` | `number` | Optional max concurrent requests. |
| `concurrencyLeaseMs` | `number` | Lease duration for concurrency permits. |

---

## 8. API Reference — Distributed Coordination

### `createCoordinationClient(redis, options)`

Creates a client exposing all coordination primitives.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `redis` | `Redis` | Yes | — | Target client. |
| `keyPrefix` | `string` | No | — | Key namespace for coordination keys. |

### Primitives

| Primitive | Method | Description |
|---|---|---|
| Distributed lock | `.lock(resource)` | Mutex with fencing tokens, TTL, renewal, safe release. |
| Semaphore | `.semaphore(resource)` | Counting permits with lease expiration. |
| Lease | `.lease(resource)` | Time-bound ownership with epoch fencing. |
| Leader election | `.leaderElection(resource)` | Term-based leader acquisition/loss. |
| Singleton scheduler | `.singletonScheduler(resource)` | One-owner periodic task scheduling. |
| Job claim | `.jobClaim(jobId)` | At-least-once claim/complete/release. |
| Barrier | `.barrier(resource)` | Arrive-and-wait synchronization. |
| Fencing | `.fencing(resource)` | Validate/compare/bump fencing tokens. |
| Resource lease | `.resourceLease(resource)` | Lease wrapper over arbitrary resources. |
| Single-flight | `.singleFlight(resource)` | Dedupe concurrent same-key execution. |

---

## 9. API Reference — Caching

### `createRedisCache(redis, options)`

Creates a cache with L1 in-process layer and Redis-backed layer.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `redis` | `Redis` | Yes | — | Target client. |
| `defaultTtlSeconds` | `number` | No | `300` | Default TTL for entries without explicit TTL. |
| `localL1` | `object` | No | `{}` | `{ enabled, ttlSeconds, maxEntries, sizePolicy }`. |
| `writeBehind` | `object` | No | `{}` | `{ enabled, flushIntervalMs }`. |
| `staleWhileRevalidate` | `boolean` | No | `false` | Serve stale while revalidating. |
| `negativeTtlSeconds` | `number` | No | — | TTL for cached null results. |
| `metrics` | `boolean` | No | `false` | Enable cache metrics. |

### Core cache methods

| Method | Description |
|---|---|
| `get(key)` | Retrieve a cached value. |
| `set(key, value, options?)` | Store a value with optional TTL and tags. |
| `getOrLoad(key, loader, options?)` | Read-through with stampede protection. |
| `invalidate(key)` | Remove a specific key. |
| `invalidateTag(tag)` | Remove all entries with a tag. |
| `shutdown()` | Stop background flush jobs and clear state. |

---

## 10. API Reference — Resilience Engine

### `createResilientRedis(client, options)` or `createResilienceEngine(client, options)`

Wraps an ioredis client with outage fallback and recovery.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Disable entirely for pass-through mode. |
| `maxOperations` | `number` | `10000` | Max pending journal entries and local entries. |
| `maxPayloadBytes` | `number` | `50 MiB` | Max estimated total memory for journal/local store. |
| `maxOperationBytes` | `number` | `1 MiB` | Max size of a single journaled operation. |
| `maxRetries` | `number` | `3` | Max replay attempts per operation. |
| `baseDelayMs` | `number` | `100` | Base retry delay for recovery. |
| `maxDelayMs` | `number` | `5000` | Cap for retry delay. |
| `recoveryBatchSize` | `number` | `50` | Max operations per recovery batch. |
| `conflictPolicy` | `"overwrite" \| "reject" \| "abort"` | `"overwrite"` | Recovery conflict handling. |
| `logger` | `Logger` | — | Optional logger. |

### Operation outcomes

| Outcome | Meaning |
|---|---|
| `EXECUTED` | Command ran now (directly or served locally). |
| `BUFFERED` | Applied locally and journaled for recovery. |
| `REJECTED` | Not eligible or capacity exceeded. |
| `EXPIRED` | Deadline passed before execution/recovery. |
| `FAILED` | Permanent failure or retry exhaustion. |
| `AMBIGUOUS` | Redis may have executed but result lost; no blind replay. |

### Supported commands during outage

**Reads:** `get`, `exists`, `ttl`, `hget`, `smembers`

**Writes:** `set`, `setex`, `setnx`, `del`, `expire`, `sadd`, `srem`, `hset`, `hdel`, `getset`

**Never eligible:** `incr`, `incrby`, `decr`, `decrby`, locks, transactions, arbitrary unsupported commands.

---

## 11. API Reference — At-Least-Once Jobs

### Enabling jobs

Pass `jobAtLeastOnce` options to `createClient()`:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `enabled` | `boolean` | Yes | — | Enable job processing. |
| `queueName` | `string` | No | `"app-jobs"` | BullMQ queue name. |
| `concurrency` | `number` | No | `5` | Max concurrent jobs. |
| `attempts` | `number` | No | `3` | Retry attempts. |
| `backoff` | `object` | No | `{ type: "exponential", delay: 1000 }` | Back-off policy. |
| `dlq` | `object` | No | — | `{ queueName, preservePayload }` for dead-letter handling. |

### Methods on `client.jobAtLeastOnce`

| Method | Description |
|---|---|
| `add(name, data, options?)` | Enqueue a single job. |
| `addBulk(jobs)` | Enqueue multiple jobs. |
| `schedule(name, data, repeatOptions)` | Schedule a recurring job. |
| `createWorker(processor, options?)` | Create a worker to process jobs. |
| `status()` | Return `{ enabled, queueName, isClosed }`. |
| `close()` | Gracefully close workers, events, and queues. |

---

## 12. API Reference — Auth Stores & Core Helpers

### `createRedisSessionStore(redis, options?)`

Session store with per-user version counters and revoked-session flags.

### `createRedisRefreshStore(redis, options?)`

Refresh token store with TTL and atomic consume.

### `createRedisStateStore(redis, options?)`

Temporary single-use state store with TTL and atomic consume (for OAuth state, password-reset tokens, etc.).

### `createRedisStores(redis, options?)`

Factory returning all three stores above.

### Core helpers

| Helper | Description |
|---|---|
| `buildKey(...parts)` | Validated namespace/key builder. Throws on empty segments. |
| `serialize(value)` / `deserialize(raw)` | JSON codec helpers. |
| `compareAndSwap(client, key, expected, next, options?)` | Optimistic atomic CAS. |
| `setIfAbsent(client, key, value, options?)` | Atomic write gate (`SET NX`). |
| `jitterTtl(baseSeconds, jitter?)` | TTL jitter to prevent stampedes. |
| `detectCapabilities(client)` | Redis feature/protocol detection. |
| `createScheduledSessionRevocation(config)` | Queue-backed delayed session revocation via BullMQ. |

---

## 13. Parameter Specifications

This section consolidates precise parameter definitions across all APIs.

### Client creation (`createClient`)

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `url` | `string` | Must be a valid `redis://` URL; throws if missing | `process.env.REDIS_URL` |
| `lazyConnect` | `boolean` | — | `true` |
| `maxRetriesPerRequest` | `number \| null` | `null` recommended for BullMQ compatibility | `null` |
| `lazyConnect: false` | — | Connects eagerly on creation | — |

### Health check (`health`)

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `timeout` | `number` | Must be > 0; invalid/negative falls back | `1000` ms |

### Shutdown (`shutdown`)

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `timeout` | `number` | Must be > 0 | `5000` ms |

### Rate limiter (`createRateLimiter`)

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `limit` | `number` | Must be > 0 | — |
| `intervalMs` | `number` | Must be > 0 | — |
| `cost` (consume) | `number` | Finite, positive (> 0) | `1` |
| `failurePolicy` | `"fail-open" \| "fail-closed"` | — | `"fail-closed"` |

### Concurrency limiter (`createConcurrencyLimiter`)

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `maxConcurrency` | `number` | Must be ≥ 1 | — |
| `leaseMs` | `number` | Must be > 0 | — |

### Cache (`createRedisCache`)

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `defaultTtlSeconds` | `number` | Must be > 0 | `300` |
| `localL1.maxEntries` | `number` | Must be > 0 | — |
| `localL1.ttlSeconds` | `number` | Must be > 0 | — |

### Resilience (`createResilienceEngine`)

| Parameter | Type | Constraints | Default |
|---|---|---|---|
| `maxOperations` | `number` | Must be > 0 | `10000` |
| `maxPayloadBytes` | `number` | Must be > 0 | `50 MiB` |
| `maxOperationBytes` | `number` | Must be > 0 | `1 MiB` |
| `maxRetries` | `number` | Must be ≥ 0 | `3` |
| `recoveryBatchSize` | `number` | Must be ≥ 1 | `50` |

---

## 14. Usage Examples

### 14.1 Basic client (read/write)

```typescript
import { createClient, health, shutdown } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });

await health(redis, { timeout: 1000 });

await redis.set("user:1", JSON.stringify({ name: "Alice" }));
const raw = await redis.get("user:1");
const user = JSON.parse(raw!);

await shutdown(redis);
```

### 14.2 Rate-limited API handler

```typescript
import { createClient, createRateLimiter, shutdown } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });
const limiter = createRateLimiter(redis, {
  algorithm: "sliding-window",
  limit: 100,
  intervalMs: 60_000,
  failurePolicy: "fail-open",
});

async function handleRequest(userId: string) {
  const result = await limiter.consume(userId, 1);
  if (!result.allowed) {
    return { status: 429, retryAfter: result.retryAfterMs };
  }
  // proceed with request logic
  return { status: 200 };
}

await shutdown(redis);
```

### 14.3 Distributed lock with fencing

```typescript
import { createClient, createCoordinationClient, shutdown } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });
const coord = createCoordinationClient(redis, { keyPrefix: "myapp:" });
const lock = coord.lock("inventory:123");

try {
  await lock.acquire({ ttlMs: 30_000 });
  // critical section
  await updateInventory();
} finally {
  await lock.release();
}

await shutdown(redis);
```

### 14.4 Cache-aside with stampede protection

```typescript
import { createClient, createRedisCache, shutdown } from "@oneunit/redis";

const redis = createClient({ url: process.env.REDIS_URL });
const cache = createRedisCache(redis, {
  defaultTtlSeconds: 300,
  localL1: { enabled: true, ttlSeconds: 60, maxEntries: 10_000 },
  staleWhileRevalidate: true,
});

const user = await cache.getOrLoad("user:42", async () => {
  return await db.users.findById(42);
});

await shutdown(redis);
```

### 14.5 Transparent outage fallback (resilience)

```typescript
import { createClient } from "@oneunit/redis";

const redis = createClient({
  url: process.env.REDIS_URL,
  resilience: {
    fallback: { enabled: true },
    recovery: { enabled: true, autoRecover: true },
  },
});

// During an outage, eligible reads are served locally; writes are journaled
await redis.set("session:abc", { userId: 1 });
const session = await redis.get("session:abc");
```

### 14.6 At-least-once job processing

```typescript
import { createClient } from "@oneunit/redis";

const jobClient = createClient({
  url: process.env.REDIS_URL,
  jobAtLeastOnce: {
    enabled: true,
    queueName: "app-jobs",
    concurrency: 10,
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
  },
});

const worker = jobClient.jobAtLeastOnce.createWorker(async (job) => {
  await doWork(job.data);
  return { success: true };
});

await jobClient.jobAtLeastOnce.add("send-email", { to: "user@example.com" });
```

### 14.7 Graceful shutdown ordering

```typescript
process.on("SIGTERM", async () => {
  await worker.close(true);
  await queueEvents.close();
  await queue.close();
  await shutdown(redis);
  process.exit(0);
});
```

---

## 15. Troubleshooting & FAQ

### Q1: `createClient` throws "No Redis URL provided"

**Cause:** No `url` argument and `REDIS_URL` environment variable is missing.

**Fix:** Set `REDIS_URL` or pass `url` explicitly:

```typescript
const redis = createClient({ url: "redis://127.0.0.1:6379" });
```

### Q2: `ECONNREFUSED` when connecting

**Cause:** Redis is not running at the configured host/port.

**Fix:** Start Redis (`docker run -d -p 6379:6379 redis:alpine`) or correct `REDIS_URL`. Use `health()` to verify reachability before relying on the client.

### Q3: `CROSSSLOT` error in Redis Cluster

**Cause:** Coordination/rate-limit keys span multiple hash slots.

**Fix:** Use `{resource}` hash tags so related keys land on the same slot:

```typescript
const lock = coord.lock("{my-resource}:inventory:123");
```

### Q4: `"Connection is closed."` unhandled rejection

**Cause:** BullMQ duplicates the ioredis client internally; a duplicate connection's handshake races with `disconnect()`.

**Fix:** The package patches `Redis.prototype.connect` automatically to absorb this benign rejection. Ensure you are using the latest version. If you see this with older code, upgrade `@oneunit/redis`.

### Q5: Worker not processing jobs

**Cause:** Worker name does not match queue name, or `concurrency` is not set, or the worker was never started.

**Fix:** Verify `name` matches between `createQueue` and `createWorker`, and call `worker.run()` or ensure the worker starts automatically. Check BullMQ worker events (`failed`, `completed`).

### Q6: `keyPrefix` is incompatible with BullMQ

**Cause:** `createClient({ keyPrefix: "app:" })` throws.

**Fix:** Do not set `keyPrefix` on the client. Use the `prefix` option on queues/workers/coordination instead.

### Q7: Resilience engine buffers but never recovers

**Cause:** Redis came back but recovery was not triggered or `autoRecover` is disabled.

**Fix:** Call `engine.recover()` manually, or enable `recovery: { autoRecover: true }` when creating the resilient client.

### Q8: At-least-once jobs are inactive / throw "disabled"

**Cause:** `jobAtLeastOnce.enabled` is `false` or not set.

**Fix:** Pass `jobAtLeastOnce: { enabled: true, ... }` to `createClient()`.

---

## 16. Optimization & Best Practices

### Connection management

- **Use `lazyConnect: true`** (default) to defer connection until first command — reduces cold-start latency.
- **Share one client** across queues, workers, rate limiters, and coordination primitives instead of creating multiple connections.
- **Set `maxRetriesPerRequest: null`** when sharing a client with BullMQ workers to avoid unbounded reconnect loops.

### Shutdown

- **Always implement graceful shutdown** in order: workers → QueueEvents → queues → client.
- **Call `shutdown()`** in your `SIGTERM`/`SIGINT` handler; it is idempotent and bounded (5 s default).
- **Never create clients at module top-level** without a corresponding shutdown path.

### Rate limiting

- **Prefer sliding-window** for strict limits without boundary bursts, but be aware of higher memory usage (sorted set per key).
- **Use fixed-window** for simple, low-overhead throttling — accept the 2× burst at boundaries.
- **Enable fail-open** only if graceful degradation is acceptable; fail-closed is safer for strict protection.
- **Compose limiters** with `createMultiRateLimiter` for per-user + global limits instead of manual logic.

### Caching

- **Enable L1 cache** (`localL1.enabled`) for frequently read keys — sub-millisecond hits.
- **Use tag invalidation** (`invalidateTag`) instead of scanning keys when invalidating related entries.
- **Set `staleWhileRevalidate: true`** for read-heavy workloads where slightly stale data is acceptable.
- **Enable metrics** (`metrics: true`) to monitor hit rates and tune TTL/size policies.

### Resilience

- **Only enable resilience for workloads that can tolerate eventual consistency** — the engine is process-local and not crash-durable.
- **Set `maxOperations`** based on expected outage duration × write rate to avoid memory pressure.
- **Handle `AMBIGUOUS` outcomes** explicitly at the application layer — re-read authoritative state or apply idempotency keys.
- **Do not rely on resilience for cross-instance coordination** — each instance maintains its own buffer.

### Jobs / queues

- **Set `concurrency`** based on your downstream capacity, not just CPU cores.
- **Use DLQ** (`dlq: { queueName, preservePayload }`) for failed jobs that need manual inspection.
- **Set retention** (`removeOnComplete`, `removeOnFail`) to prevent unbounded job growth.
- **Use `scheduleJob`** for recurring work instead of manual cron + enqueue.

### Security

- **Never hard-code credentials** — inject `REDIS_URL` via environment variables or secrets.
- **Do not log raw errors** — use `redactError()` before logging any Redis error.
- **Use TLS** for live connections (pass-through to ioredis options).

### Testing

- **Run integration tests against a real Redis instance** — never mock the connection in a way that hides timeout/backpressure behavior.
- **Never silently skip tests** when Redis is unavailable — configure your CI to start an ephemeral Redis container.

---

## 17. Glossary

| Term | Definition |
|---|---|
| **machism** | Codename for `@oneunit/redis` — the integration layer over ioredis and BullMQ. |
| **Subpath import** | Importing from `@oneunit/redis/client`, `@oneunit/redis/rate-limit`, etc., to load only needed code. |
| **Lazy connect** | Deferring the TCP connection until the first Redis command. |
| **L1 cache** | In-process, in-memory cache layer sitting in front of Redis. |
| **Write-behind** | Writing to the local store immediately and flushing to Redis asynchronously. |
| **Stale-while-revalidate** | Serving a stale cached value while asynchronously fetching fresh data. |
| **At-least-once** | Job processing guarantee that a job is processed at least once (duplicates possible). |
| **Fencing token** | Monotonically increasing token used to detect stale lock holders. |
| **AMBIGUOUS** | Resilience outcome indicating a command may have executed but the result was lost. |

---

## 18. Documentation Index

| Document | Purpose |
|---|---|
| **README.md** | Complete user manual (this file). |
| **[Architecture](docs/ARCHITECTURE.md)** | Design principles, core logic, structural diagrams, ownership contracts, deployment scenarios. |
| **[Client API](docs/client/README.md)** | `createClient`, health checks, shutdown, transactions, Sentinel/Cluster. |
| **[Queues & Workers](docs/queue/README.md)** | BullMQ factories, job lifecycle, DLQ, events. |
| **[Pipeline](docs/pipeline/README.md)** | Bounded pipeline batching. |
| **[Rate Limiting](docs/rate-limit/README.md)** | Algorithms, quotas, concurrency, burst protection. |
| **[Coordination](docs/coordination/README.md)** | Locks, semaphores, leader election, barriers. |
| **[Cache](docs/cache/README.md)** | L1 cache, write-behind, SWR, tag invalidation. |
| **[Resilience](docs/resilience/README.md)** | Outage fallback, recovery, local store. |
| **[Features & Auth Stores](docs/features/README.md)** | Session, refresh-token, state stores, scheduled revocation. |
| **[Jobs](docs/jobs/README.md)** | At-least-once processing. |

---

## 19. License

MIT License — see [LICENSE](LICENSE) for details.
