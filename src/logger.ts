const LOGGER_KEYS = ["error", "warn", "info", "debug"] as const;

export interface Logger {
  error(message: unknown, extra?: unknown): void;
  warn(message: unknown, extra?: unknown): void;
  info(message: unknown, extra?: unknown): void;
  debug(message: unknown, extra?: unknown): void;
  child?(bindings?: Record<string, unknown>): Logger;
}

export const silentLogger: Logger = Object.freeze({
  error() {},
  warn() {},
  info() {},
  debug() {},
});

export const consoleLogger: Logger = Object.freeze({
  error(message: unknown, extra?: unknown) {
    write(console.error, message, extra);
  },
  warn(message: unknown, extra?: unknown) {
    write(console.warn, message, extra);
  },
  info(message: unknown, extra?: unknown) {
    write(console.info, message, extra);
  },
  debug(message: unknown, extra?: unknown) {
    write(console.debug, message, extra);
  },
});

/**
 * Does this logger take `(bindings, message)` instead of `(message, extra)`?
 *
 * pino and its drop-in forks accept `log.info(bindings, message)`, where the
 * first argument is merged into the record and the second is the message.
 * Those signatures are indistinguishable at the call site, so a caller has to
 * be detected rather than chosen.
 *
 * `child()` was the first thing tried here and it is not a usable signal: this
 * package's own `Logger` interface declares `child?()`, so every conforming
 * logger is allowed to have one. Swapping arguments for those loggers silently
 * moved the message into the bindings slot of every record.
 *
 * A pino instance exposes both `bindings()` and the `levels` map. `child()`
 * loggers inherit `bindings()` from the same prototype, so a caller that hands
 * us `logger.child({ service: "redis" })` is still recognised. Custom loggers
 * have neither.
 */
function isBindingsFirst(logger: Logger): boolean {
  const candidate = logger as unknown as Record<string, unknown>;

  return (
    typeof candidate.bindings === "function" &&
    typeof candidate.levels === "object" &&
    candidate.levels !== null
  );
}

export function isLogger(value: unknown): value is Logger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const hasLogFn = LOGGER_KEYS.some(
    (key) => typeof (value as Record<string, unknown>)[key] === "function",
  );
  if (!hasLogFn) {
    return false;
  }

  return true;
}

/**
 * Complete a caller-supplied logger, or keep "no logger" as no logging.
 *
 * `createLogger` is the public entry point and defaults to the console, which
 * is right when someone asks for a logger. Internal call sites are different:
 * every `createClient(url)` in the wild passes nothing and expects silence, so
 * they need a logger that is either complete or absent. Without this, a logger
 * that implements only some levels throws `logger?.info is not a function` from
 * a connection event, where it is least likely to be caught.
 */
export function normalizeLogger(logger?: Logger | null): Logger | undefined {
  if (!logger) {
    return undefined;
  }

  return createLogger(logger);
}

export function createLogger(input?: Logger | null): Logger {
  if (!input) {
    return consoleLogger;
  }

  if (input === silentLogger || input === consoleLogger) {
    return input;
  }

  return {
    error(message: unknown, extra?: unknown) {
      invoke(input, "error", message, extra);
    },
    warn(message: unknown, extra?: unknown) {
      invoke(input, "warn", message, extra);
    },
    info(message: unknown, extra?: unknown) {
      invoke(input, "info", message, extra);
    },
    debug(message: unknown, extra?: unknown) {
      invoke(input, "debug", message, extra);
    },
  };
}

function write(
  fn: (...args: unknown[]) => void,
  message: unknown,
  extra?: unknown,
): void {
  if (extra === undefined) {
    fn(message);
    return;
  }
  fn(message, extra);
}

function invoke(
  logger: Logger,
  level: "error" | "warn" | "info" | "debug",
  message: unknown,
  extra?: unknown,
): void {
  const fn =
    typeof logger[level] === "function"
      ? logger[level]
      : typeof logger.info === "function"
        ? logger.info
        : undefined;

  if (typeof fn !== "function") {
    return;
  }

  if (extra === undefined) {
    fn.call(logger, message);
    return;
  }

  if (isBindingsFirst(logger)) {
    fn.call(logger, extra, message);
    return;
  }

  fn.call(logger, message, extra);
}
