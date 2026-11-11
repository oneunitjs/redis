import { createClient, health, silentLogger } from "../dist/index.js";

/** The Redis every server-backed test points at. */
export const TEST_REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

/**
 * Whether a Redis is listening, memoised per importing file.
 *
 * The queue, worker, and pipeline tests need a real server: BullMQ builds its
 * own connections and a blocking one that keeps retrying a dead port long
 * after `close()`, so asserting against an unreachable Redis is slow and leaks
 * handles. Those tests no-op when nothing is listening rather than failing.
 *
 * The memo is per-module, so each test file probes at most once no matter how
 * many of its tests ask. Node runs test files in separate processes, so this is
 * one probe per file rather than one for the suite.
 *
 * `Promise.race` is a backstop around `health()`, which already bounds itself.
 * ioredis queues commands while reconnecting, so a probe against a host that
 * blackholes packets would otherwise sit until the OS TCP timeout; the race
 * turns that into a bounded "no" and keeps an unreachable-Redis run fast. The
 * earlier copies of this helper had drifted — some had this backstop, some did
 * not — so the guard that decides whether the whole server-backed half of the
 * suite silently does nothing lived in four places with two shapes.
 */
export async function redisAvailable(): Promise<boolean> {
  const probe = createClient(
    { url: TEST_REDIS_URL, connectTimeout: 500, retryStrategy: () => null },
    silentLogger,
  );

  try {
    return await Promise.race([
      health(probe, { timeout: 1000 }).then((result) => result.status === "up"),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

/**
 * A per-file cache for `redisAvailable`.
 *
 * Call once at module scope: `const isRedisUp = cachedRedisAvailable();`
 */
export function cachedRedisAvailable(): () => Promise<boolean> {
  let cached: boolean | undefined;

  return async () => {
    if (cached !== undefined) {
      return cached;
    }

    cached = await redisAvailable();

    return cached;
  };
}
