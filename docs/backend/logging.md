# Log file

The Rust core writes `nixe.log` in the app log directory (`app_log_dir`: `~/.local/share/dev.nixe.app/logs` on
Linux, `~/Library/Logs/dev.nixe.app` on macOS, `%LOCALAPPDATA%\dev.nixe.app\logs` on Windows). The start logs
the version, the OS and the config, data and log directories.

- **Facade:** `log` with `tauri-plugin-log` (`logging.rs`, `lib.rs`). A debug build also writes to stderr.
  Desktop only; mobile builds have no log file.
- **Rotation:** by size, at 2 MB, and the last 3 files are kept (`nixe_<timestamp>.log`).
- **Levels:** `error`, `warn`, `info`, `debug`; the default is `info`. `NIXE_LOG=debug` raises it, or the
  `logLevel` key of `settings.json` in the app config directory. `NIXE_LOG` wins.
- **In the app (#412):** the commands *Show log* (the log as a read-only text in a tab, newest lines at the end),
  *Copy log* (the last 500 lines on the clipboard, for a bug report) and *Reveal log folder* are in the command
  palette and the Help menu. Settings → General names the log folder and has *Log level* (the four levels);
  a change applies at once through `log_set_level`, without a restart. `NIXE_LOG` still wins. The Rust side
  is `log_path`, `log_read { lines }` and `log_set_level { level }` in `logging.rs`; the frontend side is
  `LogActionsService` (`core/log/`) and the log tab (`features/log/`).
- **Failed commands (#522):** the modules that call the commands (`core/file/backend.ts`,
  `core/terminal/terminal-backend.ts`) import `loggedInvoke` (`core/log/logged-invoke.ts`) instead of `invoke` of
  `@tauri-apps/api/core`. It has the same signature; when a command rejects it sends the name and the error text
  to `log_command_error` and rethrows the original error. The arguments are not sent. Tauri's own `invoke` is
  not replaced (`__TAURI_INTERNALS__.invoke` is read-only in Tauri 2, #520; a spec fails when a module assigns to
  it). `log_command_error` itself is never reported, and `LogService` keeps the plain `invoke`, so a failing log
  does not log again. Calls of the spike views (`git-spike`, `editor-spike`) use the plain `invoke` and are not logged.
- **Frontend lines:** `LogService` (`core/log/log.service.ts`) forwards `console.error`, `console.warn` (and so
  the uncaught errors that `provideBrowserGlobalErrorListeners` hands to Angular) and the toast of an error
  (`showError`) to `log_write { level, message }`; they appear as `frontend: …`. Without Tauri nothing is
  written; the demo build prints the line with `console.info`.
- **Sign-in through `gh`:** each step is logged (`gh` found, token taken over, web login started,
  cancelled, stored) and the failure reason.
- **Never in the log:** a token, a password, the one-time code, the text of a note. Tests in `credentials.rs`,
  `gitprovider.rs` and `logging.rs` capture the log and check this.
- **Not changed:** the CLI (`nixe search`, …), the MCP server and the headless `nixe export` write to
  stdout and stderr as before; they start no logger.
