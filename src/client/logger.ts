/**
 * Structured logging interface for PayMux.
 *
 * When `debug: true` and no custom logger, uses a built-in formatter that
 * outputs the same `[paymux]` prefixed lines as before (backward compatible).
 *
 * When a custom logger is provided, passes structured data objects so
 * production logging systems (Datadog, Pino, Winston, etc.) can index fields.
 */

/**
 * Logger interface accepted by PayMux config.
 *
 * Each method receives a message string and an optional structured data object.
 * - For the default logger: `message` is the formatted `[paymux] ...` line, `data` is ignored.
 * - For custom loggers: `message` is a machine-readable event name (e.g. `'request_start'`),
 *   and `data` contains structured fields.
 */
export interface PayMuxLogger {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Default logger — outputs `[paymux]` prefixed lines to console.
 * Used when `debug: true` and no custom logger is provided.
 */
export class DefaultLogger implements PayMuxLogger {
  debug(message: string, _data?: Record<string, unknown>): void {
    console.log(message);
  }
  info(message: string, _data?: Record<string, unknown>): void {
    console.log(message);
  }
  warn(message: string, _data?: Record<string, unknown>): void {
    console.warn(message);
  }
  error(message: string, _data?: Record<string, unknown>): void {
    console.error(message);
  }
}

/**
 * Silent logger — discards all output. Used when logging is disabled.
 */
export class NoopLogger implements PayMuxLogger {
  debug(_message: string, _data?: Record<string, unknown>): void {}
  info(_message: string, _data?: Record<string, unknown>): void {}
  warn(_message: string, _data?: Record<string, unknown>): void {}
  error(_message: string, _data?: Record<string, unknown>): void {}
}

/**
 * Resolve the logger from PayMux config options.
 *
 * Priority:
 * 1. `logger: false` -> NoopLogger (all logging disabled)
 * 2. `logger: { ... }` -> user-provided custom logger
 * 3. `debug: true` -> DefaultLogger (console output)
 * 4. Otherwise -> NoopLogger (silent by default)
 */
export function resolveLogger(options: {
  debug?: boolean;
  logger?: PayMuxLogger | false;
}): PayMuxLogger {
  if (options.logger === false) {
    return new NoopLogger();
  }
  if (options.logger) {
    return options.logger;
  }
  if (options.debug) {
    return new DefaultLogger();
  }
  return new NoopLogger();
}
