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
- **Failed commands:** the frontend tries to wrap the Tauri IPC once (`core/log/command-log.ts`) and to send the
  name and the error text of each rejected command to `log_command_error`; the arguments are not sent. Tauri 2
  defines `__TAURI_INTERNALS__.invoke` as read-only, so the wrapper cannot be installed there:
  `installCommandLog` returns `false` and no command failure is logged this way (#520). The app starts as before;
  logging failed commands needs another route.
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
