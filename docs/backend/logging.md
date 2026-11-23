# Log file

The Rust core writes `nixe.log` in the app log directory (`app_log_dir`: `~/.local/share/dev.nixe.app/logs` on
Linux, `~/Library/Logs/dev.nixe.app` on macOS, `%LOCALAPPDATA%\dev.nixe.app\logs` on Windows). The start logs
the version, the OS and the config, data and log directories.

- **Facade:** `log` with `tauri-plugin-log` (`logging.rs`, `lib.rs`). A debug build also writes to stderr.
  Desktop only; mobile builds have no log file.
- **Rotation:** by size, at 2 MB, and the last 3 files are kept (`nixe_<timestamp>.log`).
- **Levels:** `error`, `warn`, `info`, `debug`; the default is `info`. `NIXE_LOG=debug` raises it, or the
  `logLevel` key of `settings.json` in the app config directory. `NIXE_LOG` wins.
- **Failed commands:** the frontend wraps the Tauri IPC once (`core/log/command-log.ts`) and sends the name
  and the error text of each rejected command to `log_command_error`. The arguments are not sent.
- **Sign-in through `gh`:** each step is logged (`gh` found, token taken over, web login started,
  cancelled, stored) and the failure reason.
- **Never in the log:** a token, a password, the one-time code, the text of a note. Tests in `credentials.rs`,
  `gitprovider.rs` and `logging.rs` capture the log and check this.
- **Not changed:** the CLI (`nixe search`, …), the MCP server and the headless `nixe export` write to
  stdout and stderr as before; they start no logger.
