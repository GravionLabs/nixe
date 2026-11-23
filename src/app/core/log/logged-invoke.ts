import { invoke } from "@tauri-apps/api/core";
import { errorText, LOG_COMMAND } from "./command-log";

/**
 * `invoke` of Tauri, and a command that rejects is reported to the log of the Rust core with its
 * name and error text (#410, #522). The call rejects with the original error as before. Only the
 * name and the error text are sent, never the arguments. Tauri's own `invoke` is not touched (it is
 * read-only in Tauri 2, #520).
 *
 * `log_command_error` itself is never reported (no loop), and `LogService` keeps the plain
 * `invoke` for `log_write`.
 */
export const loggedInvoke: typeof invoke = async (command, ...rest) => {
  try {
    return await invoke(command, ...rest);
  } catch (error) {
    if (command !== LOG_COMMAND) {
      try {
        invoke(LOG_COMMAND, { command, error: errorText(error) }).catch(() => undefined);
      } catch {
        // The log is an aid: a failing report never replaces the original error.
      }
    }
    throw error;
  }
};
