import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { errorText } from "./command-log";

export type LogLevel = "error" | "warn" | "info" | "debug";

/** The Tauri command that writes one line into `nixe.log` (#411). */
export const LOG_WRITE = "log_write";

/** Longest message handed to the log; the Rust core cuts it again. */
const MAX_MESSAGE = 2000;

/** A path (`/a/b.md`, `C:\\a\\b.md`) or a token-like secret in a message; neither belongs in the log. */
const PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|]*[\\/][^\s"'`<>|]*/g;
const SECRET = /\b(?:gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]+/g;

/** Hides paths of notes and tokens in a message. */
export function scrub(text: string): string {
  return text.replace(SECRET, "<token>").replace(PATH, "<path>");
}

/** One console argument as plain text: strings and errors as they are, anything else as JSON. */
function argText(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ? `${arg.message}\n${arg.stack}` : arg.message;
  return errorText(arg);
}

/**
 * The frontend side of the log file. `start()` forwards `console.error`, `console.warn` and with
 * them the uncaught errors that Angular reports (`provideBrowserGlobalErrorListeners`); `write()`
 * is for everything else, such as the toast of an error. Only a level and a text go to the Rust
 * core. A command is logged by its name and error text (`command-log.ts`), never its arguments.
 * Without Tauri (a plain browser) a write is dropped; the demo build answers `log_write` with
 * the console.
 */
@Injectable({ providedIn: "root" })
export class LogService {
  private started = false;
  private writing = false;

  /** Writes one line into the log. Never throws and never waits. */
  write(level: LogLevel, message: string): void {
    // A failing log must not log again: the console forward would loop.
    if (this.writing) return;
    this.writing = true;
    try {
      const clean = scrub(message);
      const text = clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE)}…` : clean;
      invoke(LOG_WRITE, { level, message: text }).catch(() => undefined);
    } catch {
      // No Tauri, no log file.
    } finally {
      this.writing = false;
    }
  }

  /** Forwards `console.error` and `console.warn` to the log, once. The console still prints. */
  start(target: Pick<Console, "error" | "warn"> = console): void {
    if (this.started) return;
    this.started = true;
    for (const level of ["error", "warn"] as const) {
      const original = target[level].bind(target);
      target[level] = (...args: unknown[]) => {
        original(...args);
        this.write(level, args.map(argText).join(" "));
      };
    }
  }
}
