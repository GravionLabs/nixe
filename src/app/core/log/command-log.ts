/** The command the Rust core uses to write a failed command into `nixe.log` (#410). */
export const LOG_COMMAND = "log_command_error";

type Invoke = (command: string, args?: unknown, options?: unknown) => Promise<unknown>;

interface TauriInternals {
  invoke: Invoke;
}

/** What the failed call said: an error text, an `Error` or any value, as plain text. */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Wraps the IPC entry point of Tauri, so every command that fails is reported to the log of the
 * Rust core with its name and error text. The call still rejects as before. Without Tauri (a
 * browser, the demo, a test) nothing happens. Only the error text is sent, never the arguments.
 */
export function installCommandLog(target: { __TAURI_INTERNALS__?: TauriInternals }): boolean {
  const internals = target.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") return false;
  const original = internals.invoke.bind(internals);
  internals.invoke = (command, args, options) =>
    original(command, args, options).catch((error: unknown) => {
      if (command !== LOG_COMMAND) {
        original(LOG_COMMAND, { command, error: errorText(error) }).catch(() => undefined);
      }
      throw error;
    });
  return true;
}
