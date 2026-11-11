/**
 * Shared setup for the examples in this directory.
 *
 * Every example needs the same three things: a Redis URL, a decision about
 * whether to log connection events, and a clean shutdown. Keeping that here
 * means each example file can be about its actual subject.
 *
 * These are run straight from a checkout (`npm run example:<name>`), so they
 * import the package by name rather than by relative path. Node resolves that
 * through the package's own `exports` map, which means the examples exercise
 * the same entry points a consumer gets.
 */

import { silentLogger } from "@oneunit/redis";

export const REDIS_URL = process.env.REDIS_URL;

/**
 * Connection-event logging is noisy in a demo, so `REDIS_SILENT=true` turns it
 * off. Passing `undefined` instead lets `createClient` skip the log calls while
 * still registering the ioredis `error` listener, which is what keeps a
 * transient outage from becoming an unhandled exception.
 */
export const exampleLogger =
  process.env.REDIS_SILENT === "true" ? silentLogger : undefined;

/** Resolve after `ms`, used to space out publishes and let I/O settle. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve to `"timeout"` if `promise` has not settled within `ms`.
 *
 * Worth having in every example. ioredis queues commands while reconnecting and
 * BullMQ waits on its own readiness, so against an unreachable server calls like
 * `subscribe()` or `worker.waitUntilReady()` never settle at all. Without a
 * bound the script hangs until someone kills it, which looks identical to a
 * Redis that is merely slow.
 *
 * The timer is always cleared. A pending timeout keeps the event loop alive,
 * so a losing race would silently add its full duration to the script's
 * runtime.
 */
export async function within(promise, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True if `promise` settles successfully within `ms`, false on timeout or
 * rejection.
 *
 * BullMQ readiness needs both guards. It rejects outright against a dead server
 * ("Connection is closed") rather than hanging, so a timeout race alone is not
 * enough. Letting that rejection escape would abort the example before it could
 * shut down, and BullMQ's reconnect loops would then keep the process alive
 * with nothing left to stop them.
 */
export async function isReady(promise, label, ms = 5000) {
  try {
    if ((await within(promise, ms)) === "timeout") {
      console.log(`  ${label} not ready within ${ms}ms.`);
      return false;
    }
  } catch (error) {
    console.log(`  ${label} unavailable: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Resources registered here, closed in reverse order when the example finishes.
 *
 * Every example creates its own clients, and ioredis keeps a socket open for
 * each one. If `main()` returns early or throws partway through, whoever was
 * going to call `shutdown` never gets to run, so the open socket keeps the event
 * loop alive and the script hangs until it is killed from outside. That turns a
 * clear stack trace or a tidy "Redis is not reachable" message into a timeout.
 *
 * Cleanup always runs, not only on failure. Every registered close is a no-op
 * once the resource is already gone, so running them unconditionally covers the
 * early-return paths without asking each example to repeat its own teardown.
 */
const cleanups = [];

/** Register `close` to run when the example ends. Later registrations close first. */
export function onFailure(close) {
  cleanups.push(close);
}

/**
 * Close everything registered so far, in reverse order.
 *
 * Draining the list matters for more than tidiness. `shutdown` waits out a 5s
 * QUIT deadline against an unreachable server, so a resource closed here and
 * then closed again by `run` would cost that deadline twice. Once released, it
 * is out of the list and cannot be closed again.
 *
 * Call this when the example shuts down by hand, so its own "disconnected
 * cleanly" message is only printed after the connection is really gone.
 */
export async function release() {
  const pending = cleanups.splice(0).reverse();

  for (const close of pending) {
    try {
      await close();
    } catch {
      // A cleanup that throws must not hide the original failure.
    }
  }
}

/**
 * Run an example's main function and make a failure visible in the exit code.
 *
 * `catch(console.error)` alone leaves the process exiting 0, so a broken example
 * looks like a passing one in any script that checks `$?`.
 */
export async function run(name, main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `\n${name} failed:`,
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  } finally {
    await release();
  }
}
