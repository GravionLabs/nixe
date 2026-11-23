/** The four levels of the log file, from the quietest to the most talkative. */
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** The level of a stored value; anything else is the default (`info`). */
export function sanitizeLogLevel(value: unknown): LogLevel {
  return LOG_LEVELS.find((l) => l === value) ?? DEFAULT_LOG_LEVEL;
}

/** How many of the last lines *Copy log* puts on the clipboard. */
export const COPY_LOG_LINES = 500;
