/** The command the Rust core uses to write a failed command into `nixe.log` (#410). */
export const LOG_COMMAND = "log_command_error";

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
