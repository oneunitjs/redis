import { type Redis as RedisClient, type ChainableCommander } from "ioredis";
import { normalizeLogger, type Logger } from "../logger.js";
import { redactError } from "../client/events.js";

/**
 * One command in a pipeline, plus a label for reporting failures.
 *
 * The label is what makes a failure identifiable. A pipeline result is a
 * positional array, so a bare `results[7]` tells an operator nothing about which
 * of several hundred commands went wrong; ioredis attaches the command itself to
 * the error, but only for the commands it can describe, and the label is what
 * this package logs.
 */
export interface PipelineStep {
  label: string;
  run: (pipeline: ChainableCommander) => void;
}

export interface PipelineOptions {
  /**
   * Milliseconds to wait for EXEC before giving up.
   *
   * ioredis queues commands while reconnecting and never flushes them until the
   * connection is back, so EXEC against an unreachable server does not reject —
   * it never settles. Without a bound a request handler awaiting a pipeline
   * hangs for the whole outage and takes the process's request capacity with it.
   */
  timeout?: number;
  logger?: Logger;
  /**
   * Reject if any single command in the batch failed.
   *
   * Off by default. EXEC resolves even when individual commands fail: each
   * failure arrives as a `[error, null]` tuple in the results, and a pipeline
   * that silently drops one of its writes looks exactly like a pipeline that
   * succeeded. Turn this on where a partial batch is not acceptable.
   */
  throwOnError?: boolean;
}

/** Result of one command. Mirrors ioredis's own tuple, with the error redacted. */
export interface PipelineStepResult {
  label: string;
  value: unknown;
  error?: Error;
}

export interface PipelineResult {
  results: PipelineStepResult[];
  /** Wall-clock duration of EXEC, in milliseconds. */
  durationMs: number;
  /** How many commands failed. Zero when all succeeded. */
  failed: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Whether a value is promise-like, i.e. something a caller forgot to await. */
function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class PipelineTimeoutError extends Error {
  readonly steps: number;

  constructor(timeout: number, steps: number) {
    super(
      `Redis pipeline of ${steps} command${steps === 1 ? "" : "s"} did not complete within ${timeout}ms`,
    );
    this.name = "PipelineTimeoutError";
    this.steps = steps;
  }
}

/**
 * Thrown when `throwOnError` is set and a command failed.
 *
 * Carries the per-step results so the caller can see which command broke
 * without re-running the batch. The `message` lists labels only — ioredis
 * attaches command arguments to its errors, and a pipeline that batched an
 * `AUTH` would otherwise put the password in an exception message.
 */
export class PipelineCommandError extends Error {
  readonly results: PipelineStepResult[];

  constructor(results: PipelineStepResult[]) {
    const failed = results.filter((result) => result.error);
    super(
      `Redis pipeline: ${failed.length} of ${results.length} commands failed (${failed
        .map((result) => result.label)
        .join(", ")})`,
    );
    this.name = "PipelineCommandError";
    this.results = results;
  }
}

/**
 * Thrown when a step does not queue exactly one command.
 *
 * `PipelineStep.run` is typed as returning `void`, and TypeScript allows any
 * value to be returned from a `void` signature — so a step that queues two
 * commands, or an `async` step whose command is only queued after `runPipeline`
 * has already called `exec`, compiles without complaint. Both shift the
 * positional pairing between `steps` and the result tuples, which is the one
 * thing the label exists to prevent, so the batch is rejected rather than
 * returned with a value against the wrong label.
 */
export class PipelineStepError extends Error {
  readonly label: string;
  readonly queued: number;

  constructor(label: string, queued: number) {
    super(
      `Redis pipeline step "${label}" queued ${queued} command${
        queued === 1 ? "" : "s"
      }, expected exactly 1`,
    );
    this.name = "PipelineStepError";
    this.label = label;
    this.queued = queued;
  }
}

/**
 * Run a batch of commands in one round trip.
 *
 * Wraps `client.pipeline()` rather than reimplementing it. The value is in the
 * four sharp edges this closes, all of which are silent in ioredis itself:
 *
 * 1. **A failed command does not fail the pipeline.** EXEC resolves with a
 *    `[error, null]` tuple for the command that failed. Code that reads
 *    `results.map(([, value]) => value)` gets `null` and carries on as if the
 *    write landed. Every result here carries an explicit `error` field.
 * 2. **EXEC can hang forever.** ioredis parks queued commands while
 *    reconnecting. `timeout` bounds that.
 * 3. **Command errors carry their arguments.** Redacted via `redactError`
 *    before they reach a logger or an exception — on both the per-command
 *    results and a rejected `exec()`.
 * 4. **Results are positional.** Each step must queue exactly one command, or
 *    every later label is paired with the wrong value. A step that does not
 *    raises `PipelineStepError`.
 */
export async function runPipeline(
  client: RedisClient,
  steps: PipelineStep[],
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const logger = normalizeLogger(options.logger);
  const requested = options.timeout ?? DEFAULT_TIMEOUT_MS;
  // setTimeout coerces a negative or NaN budget to 1ms and prints a warning for
  // each; treat any invalid value as "no bound configured" instead.
  const timeout =
    Number.isFinite(requested) && requested > 0
      ? requested
      : DEFAULT_TIMEOUT_MS;

  if (steps.length === 0) {
    // No round trip is needed, and building a pipeline just to exec an empty
    // one is a wasted allocation.
    return { results: [], durationMs: 0, failed: 0 };
  }

  const pipeline = client.pipeline();

  for (const step of steps) {
    // Results are paired with steps by position, so the queue has to grow by
    // exactly one per step. `length` is ioredis's own queue length, and it is
    // read before and after rather than counted here so the check is against
    // what was actually queued, not against what `run` appears to have done.
    const before = pipeline.length;

    let returned: unknown;

    try {
      returned = step.run(pipeline);
    } catch (error) {
      // A throwing `run` means the command was never queued, so the batch is
      // already malformed. Fail the whole pipeline: silently dropping the
      // command would shift every later result by one and return the wrong
      // value against the wrong label.
      logger?.error(`Redis pipeline step failed to queue: ${step.label}`, {
        err: redactError(error),
      });

      throw error;
    }

    const queued = pipeline.length - before;

    if (isThenable(returned)) {
      // An `async` step is invisible to the count below: it queues nothing
      // synchronously, so `exec()` runs first and the command it was going to
      // queue lands in a pipeline that has already been sent. TypeScript
      // permits returning a value from a `void`-typed signature, so this is
      // not a compile error either.
      //
      // The step's promise is abandoned here, so its eventual rejection is
      // nobody's to handle — which on Node 20 is a process-level crash that
      // would mask the error naming the actual fault. Swallow it; the throw
      // below is the real diagnosis.
      void Promise.resolve(returned).catch(() => undefined);

      logger?.error(
        `Redis pipeline step returned a promise instead of queuing: ${step.label}`,
      );

      throw new PipelineStepError(step.label, queued);
    }

    if (queued !== 1) {
      logger?.error(
        `Redis pipeline step queued ${queued} commands: ${step.label}`,
      );

      throw new PipelineStepError(step.label, queued);
    }
  }

  const started = performance.now();

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeout);
  });

  let raw: Array<[Error | null, unknown]>;

  try {
    const outcome = await Promise.race([pipeline.exec(), expiry]);

    if (outcome === "timeout") {
      throw new PipelineTimeoutError(timeout, steps.length);
    }

    raw = outcome as Array<[Error | null, unknown]>;
  } catch (error) {
    if (error instanceof PipelineTimeoutError) {
      throw error;
    }

    // A rejected `exec()` is a connection-level failure, and it bypasses the
    // per-tuple redaction below entirely. The module documents that errors are
    // redacted, so the rejection goes through the same path rather than
    // reaching the caller — and from there a logger — as ioredis built it.
    throw redactError(error);
  } finally {
    // A pending timeout keeps the event loop alive. Always clear it, including
    // on the timeout path where it has already fired.
    clearTimeout(timer);
  }

  const results: PipelineStepResult[] = raw.map(([error, value], index) => {
    const step = steps[index];

    return {
      label: step?.label ?? `#${index}`,
      value,
      // Redacted here rather than at each call site so a caller that logs a
      // whole result array cannot leak credentials by accident.
      ...(error ? { error: redactError(error) as Error } : {}),
    };
  });

  const failed = results.filter((result) => result.error).length;
  const durationMs = Math.round(performance.now() - started);

  if (failed > 0) {
    logger?.warn(
      `Redis pipeline: ${failed} of ${results.length} commands failed`,
    );
  }

  logger?.debug?.(
    `Redis pipeline completed ${results.length} command${
      results.length === 1 ? "" : "s"
    } in ${durationMs}ms`,
  );

  if (failed > 0 && options.throwOnError) {
    throw new PipelineCommandError(results);
  }

  return { results, durationMs, failed };
}

/**
 * Values of the successful results, in order.
 *
 * Throws if any command failed, because the alternative is handing back a
 * sparse array whose length matches the batch but whose contents silently
 * include a failed write. Use `results` directly when a partial batch is
 * expected and worth handling.
 */
export function pipelineValues(results: PipelineStepResult[]): unknown[] {
  const failed = results.find((result) => result.error);

  if (failed) {
    throw new PipelineCommandError(results);
  }

  return results.map((result) => result.value);
}
