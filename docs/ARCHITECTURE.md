# Architecture – `@oneunit/redis`

**Status:** Architecture (verified against cloud Redis & local Redis)
**Audience:** Maintainers and contributors of `@oneunit/redis`

---

## 0. Executive Summary

`@oneunit/redis` (codename **machism**) is a thin, opinionated integration layer over **ioredis** and **BullMQ**. It provides:
- Safe, explicit client construction with mandatory `REDIS_URL` handling.
- Credential redaction on all error and log paths.
- Bounded health checks, pipeline execution, and graceful shutdown.
- Optional, independently loadable subsystems: rate‑limiting, coordination, caching, resilience, auth stores, and at‑least‑once job processing.
- No hidden connection pools or framework‑specific runtime – the library returns native ioredis and BullMQ objects.

The package never replaces ioredis/BullMQ; it only adds safe defaults, contract enforcement, and tooling that prevents recurring integration failures.

---

## 1. Core Logic

| Concern | Implementation |
|---|---|
| **Client factory** | `createClient()` validates an explicit URL, enforces `lazyConnect: true` and `maxRetriesPerRequest: null` (BullMQ‑compatible), patches `Redis.prototype.connect` to swallow benign `"Connection is closed"` rejections, and returns a native `ioredis` instance. |
| **Bounded health** | `health(client, { timeout })` performs a timed `PING` and returns `{ status, latencyMs, error? }`. The promise always settles within the deadline. |
| **Pipeline** | `runPipeline()` validates exactly one command per step, reports per‑command errors, applies a configurable timeout, and redacts credentials from any error before returning. |
| **Graceful shutdown** | `shutdown(client, { timeout })` is idempotent: attempts a graceful `QUIT`, falls back to forced disconnect after the deadline, and tracks forced‑close state via a private `WeakSet`. |
| **Resilience engine** | When enabled, `createResilientRedis()` proxies supported commands to a fallback store during outages, preserves TTL on replay, and flags non‑idempotent outcomes as `AMBIGUOUS`. |
| **Coordination primitives** | All primitives (`lock`, `semaphore`, `leaderElection`, …) are implemented as atomic Lua scripts that use server‑side `TIME` and hash‑tagged keys (`{resource}`) for cluster safety. |
| **Rate limiting** | Fixed / sliding windows, token / leaky bucket, quota, concurrency, burst, multi‑dimensional, adaptive throttling, load shedding, and back‑pressure are all Lua‑based and expose a unified `checkAndConsume()` API. |
| **Caching** | `createRedisCache()` builds an L1 in‑process cache (configurable eviction policy) plus a Redis‑backed layer with write‑behind, stale‑while‑revalidate, tag invalidation, negative caching, and optional metrics. |
| **Auth stores** | Refresh, session, and state stores provide TTL‑based entries with atomic `consume()` semantics; scheduled revocation uses BullMQ delayed jobs. |

---

## 2. Structural Design

### 2.1 Dependency Direction

```
core → logger → client → queue → pipeline → rate‑limit → coordination → cache → resilience → jobs → features
```
- Shared primitives (`core`, `logger`) sit at the bottom.
- Sub‑packages never import unrelated subsystems; each subpath (`@oneunit/redis/client`, `@oneunit/redis/queue`, …) is independently loadable.
- The root barrel (`src/index.ts`) re‑exports only public symbols; no business logic lives there.

### 2.2 Ownership Contracts

| Factory | Owned resources | Who closes? |
|---|---|---|
| `createClient()` | Native ioredis instance | Application via `shutdown()` |
| `createQueue()` | Queue instance + its own connection | Caller |
| `createWorker()` | Worker + blocking connection | Caller |
| `attachQueueEvents()` | QueueEvents wrapper + connection | Caller |
| `createResilientRedis()` | Proxy façade + fallback store | Caller |

All resources expose an explicit `close()` / `shutdown()` that is safe to call multiple times.

---

## 3. Integration Patterns

| Pattern | How it works |
|---|---|
| **Root barrel** | `@oneunit/redis` re‑exports every subsystem for convenience. |
| **Subpath imports** | Tree‑shakable imports (`@oneunit/redis/client`, `@oneunit/redis/rate-limit`, …) keep dependency surfaces small and avoid side‑effects. |
| **Logger injection** | Optional logger adhering to `{ error, warn, info, debug }`; defaults to a no‑op implementation. All logs pass through a redaction layer before emission. |
| **Resilience opt‑in** | Pass `resilience` config to `createClient()` or wrap an existing client with `createResilientRedis()`. The native client remains primary unless the fallback is active. |
| **At‑least‑once jobs** | Enabled via `jobAtLeastOnce` options; the underlying BullMQ objects are lazily created only when the feature is turned on. |
| **Connection hardening** | Global prototype patch applied once per process to swallow benign connection‑closed rejections from BullMQ‑duplicated clients. |

---

## 4. Implementation Guide

### 4.1 Install
```bash
npm install @oneunit/redis
# ioredis and bullmq are bundled; @oneunit/auth is optional peer
```

### 4.2 Create the Base Client
```typescript
import { createClient, health, shutdown } from "@oneunit/redis/client";

const redis = createClient({
 url: process.env.REDIS_URL, // required – throws if missing
 lazyConnect: true,
 maxRetriesPerRequest: null, // BullMQ‑compatible
});

await health(redis, { timeout: 1000 }); // readiness check
// … application logic …
await shutdown(redis);
```

### 4.3 Enable Optional Subsystems (Opt‑In Only)
```typescript
// Resilience
const resilient = createClient({
 url: process.env.REDIS_URL,
 resilience: { fallback: { enabled: true }, recovery: { enabled: true } },
});

// At‑least‑once jobs
const jobClient = createClient({
 url: process.env.REDIS_URL,
 jobAtLeastOnce: { enabled: true, queueName: "app-jobs", concurrency: 10 },
});

const worker = jobClient.jobAtLeastOnce.createWorker(async (job) => {
 // …
});
```

### 4.4 Subsystem Integration (Sub‑path Imports)
```typescript
import { createRateLimiter } from "@oneunit/redis/rate-limit";
import { createCoordinationClient } from "@oneunit/redis/coordination";
import { createRedisCache } from "@oneunit/redis/cache";
import { buildKey, compareAndSwap } from "@oneunit/redis/features";
```

### 4.5 Shutdown Ordering (Signal Handling)
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

## 5. Use Cases (selected)
| Use case | Subsystem | Rationale |
|---|---|---|
| API request throttling per user/IP | `rate-limit` | Distributed counters, configurable fail‑open/closed behavior, retry‑after metadata. |
| Distributed mutual exclusion | `coordination` | Atomic Lua locks with fencing tokens and TTL. |
| Leader election for a singleton worker | `coordination` | Term‑based acquisition, bounded by Redis time. |
| Job queue with retries & DLQ | `jobs` + `queue` | BullMQ‑backed processing, exponential back‑off, dead‑letter handling. |
| Cache‑aside with stampede protection | `cache` | Sub‑ms L1 hits, tag‑based invalidation, stale‑while‑revalidate. |
| Session / refresh‑token stores | `features` | TTL, atomic consume, optional scheduled revocation. |
| Transparent outage fallback | `resilience` | Process‑local read‑through and write‑journal during outages, TTL‑preserving replay. |
| Distributed concurrency / burst protection | `rate-limit` | Semaphore permits, burst tiers, adaptive throttling. |
| Circuit‑sensitive pipeline batching | `pipeline` | Bounded execution, per‑command error reporting, redaction. |
| Single‑flight deduplication | `coordination` | Coalesce concurrent identical work across async calls. |

---

## 6. Deployment Scenarios

### 6.1 Standalone Redis (single instance)
```typescript
const redis = createClient({ url: process.env.REDIS_URL });
await health(redis, { timeout: 1000 });
// …
await shutdown(redis);
```
- One shared ioredis client across all subsystems.
- Use readiness/liveness probes calling `health`.

### 6.2 Redis Sentinel (HA)
```typescript
import { createSentinelClient } from "@oneunit/redis/client";
const sentinel = createSentinelClient({ sentinels: [{ host, port }], name: "mymaster" });
```
- Pass‑through Sentinel options; no extra retry logic required.

### 6.3 Redis Cluster
```typescript
import { createClusterClient } from "@oneunit/redis/features";
const cluster = createClusterClient([{ host: "node1", port: 6379 }]);
```
- Use `{resource}` hash‑tags for coordination and rate‑limit primitives to avoid CROSSSLOT errors.

### 6.4 Horizontal (multi‑instance) deployments
- Coordination primitives are safe across instances because they operate on a shared Redis state.
- The resilience engine is **process‑local only**; each instance maintains its own fallback buffer.

### 6.5 Kubernetes / Container Best Practices
- Inject `REDIS_URL` via secret; never hard‑code credentials.
- Do **not** set `keyPrefix`; use BullMQ `prefix` instead.
- Set `maxRetriesPerRequest: null` when the client is shared with BullMQ workers.
- Implement graceful shutdown ordering (workers → QueueEvents → queues → client) in a `SIGTERM` handler.
- Liveness/readiness: `health(redis, { timeout: 1000 })` → `down` = not ready.

---

## 7. Verification & Packaging
- All public subpaths are type‑checked (`npm run typecheck`) and tested against the packed tarball (`npm run pack:check`).
- CI runs the hermetic layer tests (`npm run test:layers`) against a real Redis instance to ensure bounded behavior.

---

## 8. License

MIT License – see [LICENSE](../LICENSE).
