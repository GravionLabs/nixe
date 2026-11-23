//! The log file of the Rust core (#410): `log` is the facade, `tauri-plugin-log` writes
//! `nixe.log` in the app log directory and rotates it by size. The headless `nixe export`
//! and the CLI keep writing to stderr. A token, a password or note text is never logged.

use log::LevelFilter;

/// Name of the log file without its extension (the plugin adds `.log`).
pub const LOG_FILE: &str = "nixe";
/// A log file rotates when it grows past this many bytes.
pub const MAX_FILE_BYTES: u128 = 2 * 1024 * 1024;
/// The number of rotated files kept next to the current one.
pub const KEEP_FILES: usize = 3;
/// The environment variable that sets the level (`error`, `warn`, `info`, `debug`).
pub const LEVEL_ENV: &str = "NIXE_LOG";
/// The key of the app settings file that sets the level.
pub const LEVEL_SETTING: &str = "logLevel";
/// Longest error text that the frontend may hand over to the log.
const MAX_REPORT: usize = 2000;

/// The level of a name; only the four levels of the log are known.
pub fn parse_level(name: &str) -> Option<LevelFilter> {
    match name.trim().to_ascii_lowercase().as_str() {
        "error" => Some(LevelFilter::Error),
        "warn" | "warning" => Some(LevelFilter::Warn),
        "info" => Some(LevelFilter::Info),
        "debug" => Some(LevelFilter::Debug),
        _ => None,
    }
}

/// The level in effect: `NIXE_LOG` wins over the `logLevel` of the settings file; info otherwise.
pub fn resolve_level(env: Option<&str>, settings: Option<&str>) -> LevelFilter {
    let from_setting = settings
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|v| v.get(LEVEL_SETTING)?.as_str().and_then(parse_level));
    env.and_then(parse_level)
        .or(from_setting)
        .unwrap_or(LevelFilter::Info)
}

/// The level that a change of the setting puts in effect: `NIXE_LOG` still wins, as at the start.
pub fn effective_level(env: Option<&str>, chosen: &str) -> Result<LevelFilter, String> {
    let chosen = parse_level(chosen).ok_or_else(|| format!("unknown log level: {chosen}"))?;
    Ok(env.and_then(parse_level).unwrap_or(chosen))
}

/// The last `count` lines of `text` (all of it when it has fewer), without a trailing newline.
pub fn tail_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

/// The path of the current log file inside the log directory.
pub fn log_file(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join(format!("{LOG_FILE}.log"))
}

/// The log file as text (empty while nothing is written yet); only its last `max_lines` lines.
pub fn read_log(dir: &std::path::Path, max_lines: Option<usize>) -> Result<String, String> {
    let path = log_file(dir);
    let text = match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    Ok(match max_lines {
        Some(n) => tail_lines(&text, n),
        None => text,
    })
}

/// The path of `nixe.log`; the frontend reveals it and names its folder.
#[tauri::command]
pub fn log_path(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    Ok(crate::path_to_string(&log_file(&dir)))
}

/// The text of `nixe.log`, newest lines last; `lines` keeps only the last ones.
#[tauri::command]
pub fn log_read(app: tauri::AppHandle, lines: Option<usize>) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    read_log(&dir, lines)
}

/// Applies the level of the setting at once, without a restart; returns the level in effect.
#[tauri::command]
pub fn log_set_level(level: String) -> Result<String, String> {
    let env = std::env::var(LEVEL_ENV).ok();
    let effective = effective_level(env.as_deref(), &level)?;
    // The page sets the level again at every start; only a change is worth a line.
    if log::max_level() != effective {
        log::set_max_level(effective);
        log::info!("log level {effective}");
    }
    Ok(effective.to_string().to_ascii_lowercase())
}

/// The text of a failed command for the log: one line, bounded.
fn one_line(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if flat.chars().count() > MAX_REPORT {
        let cut: String = flat.chars().take(MAX_REPORT).collect();
        format!("{cut}…")
    } else {
        flat
    }
}

/// Logs a Tauri command that failed: its name and its error text.
pub fn command_failed(command: &str, error: &str) {
    log::error!("command {} failed: {}", one_line(command), one_line(error));
}

/// The frontend reports a command that failed, so each one is in the log with its name.
#[tauri::command]
pub fn log_command_error(command: String, error: String) {
    command_failed(&command, &error);
}

/// Logs one line from the frontend (#411): `console.error`, `console.warn`, uncaught errors and
/// the toast of an error. The level is one of the four; any other counts as `info`.
pub fn frontend_line(level: &str, message: &str) {
    let level = match level.trim().to_ascii_lowercase().as_str() {
        "error" => log::Level::Error,
        "warn" | "warning" => log::Level::Warn,
        "debug" => log::Level::Debug,
        _ => log::Level::Info,
    };
    log::log!(level, "frontend: {}", one_line(message));
}

/// The frontend writes a line into the log.
#[tauri::command]
pub fn log_write(level: String, message: String) {
    frontend_line(&level, &message);
}

#[cfg(test)]
pub(crate) mod capture {
    //! A logger for tests: it keeps every record in memory.
    use std::sync::{Mutex, Once};

    static LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());
    static INIT: Once = Once::new();
    struct Capture;

    impl log::Log for Capture {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            LINES
                .lock()
                .unwrap()
                .push(format!("{} {}", record.level(), record.args()));
        }
        fn flush(&self) {}
    }

    /// Installs the logger (once per test process) and returns the lines logged so far.
    pub fn install() {
        INIT.call_once(|| {
            let _ = log::set_logger(&Capture);
            log::set_max_level(log::LevelFilter::Debug);
        });
    }

    pub fn lines() -> Vec<String> {
        LINES.lock().unwrap().clone()
    }

    /// Whether any logged line contains `needle`.
    pub fn contains(needle: &str) -> bool {
        lines().iter().any(|l| l.contains(needle))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_level_is_info() {
        assert_eq!(resolve_level(None, None), LevelFilter::Info);
        assert_eq!(
            resolve_level(Some("nonsense"), Some("{}")),
            LevelFilter::Info
        );
        assert_eq!(resolve_level(None, Some("not json")), LevelFilter::Info);
    }

    #[test]
    fn the_environment_wins_over_the_setting() {
        let settings = r#"{"logLevel":"warn"}"#;
        assert_eq!(resolve_level(None, Some(settings)), LevelFilter::Warn);
        assert_eq!(
            resolve_level(Some("DEBUG"), Some(settings)),
            LevelFilter::Debug
        );
        assert_eq!(resolve_level(Some("error"), None), LevelFilter::Error);
    }

    #[test]
    fn only_the_four_levels_are_known() {
        assert_eq!(parse_level(" Info "), Some(LevelFilter::Info));
        assert_eq!(parse_level("trace"), None);
        assert_eq!(parse_level("off"), None);
    }

    #[test]
    fn a_failed_command_logs_its_name_and_one_bounded_line() {
        capture::install();
        command_failed("read_text_file_t410", "no such file\nsecond line");
        assert!(capture::contains(
            "ERROR command read_text_file_t410 failed: no such file second line"
        ));
        command_failed("long_t410", &"x".repeat(MAX_REPORT * 2));
        let line = capture::lines()
            .into_iter()
            .find(|l| l.contains("long_t410"))
            .unwrap();
        assert!(line.chars().count() < MAX_REPORT + 60);
    }

    #[test]
    fn the_text_of_a_note_does_not_reach_the_log() {
        capture::install();
        let dir = std::env::temp_dir().join("nixe-log-t410");
        // Content that is no settings object is refused without echoing it.
        let note = "Dear diary, the launch code is 0451-t410";
        let err = crate::settings::write_settings(&dir, note).unwrap_err();
        command_failed("write_app_settings", &err);
        assert!(capture::contains("command write_app_settings failed"));
        assert!(!capture::contains("launch code"));
    }

    #[test]
    fn a_frontend_line_keeps_its_level_and_is_one_bounded_line() {
        capture::install();
        frontend_line("warn", "careful t411\nsecond");
        frontend_line("ERROR", "broke t411b");
        frontend_line("nonsense", "odd t411c");
        assert!(capture::contains("WARN frontend: careful t411 second"));
        assert!(capture::contains("ERROR frontend: broke t411b"));
        assert!(capture::contains("INFO frontend: odd t411c"));
        frontend_line("error", &"y".repeat(MAX_REPORT * 2));
        let line = capture::lines()
            .into_iter()
            .find(|l| l.contains("yyyy"))
            .unwrap();
        assert!(line.chars().count() < MAX_REPORT + 60);
    }

    #[test]
    fn a_level_change_applies_but_the_environment_still_wins() {
        assert_eq!(effective_level(None, "debug"), Ok(LevelFilter::Debug));
        assert_eq!(
            effective_level(Some("error"), "debug"),
            Ok(LevelFilter::Error)
        );
        assert_eq!(
            effective_level(Some("nonsense"), "warn"),
            Ok(LevelFilter::Warn)
        );
        assert!(effective_level(None, "trace").is_err());
    }

    #[test]
    fn the_tail_keeps_the_last_lines() {
        assert_eq!(tail_lines("a\nb\nc\nd\n", 2), "c\nd");
        assert_eq!(tail_lines("a\nb", 500), "a\nb");
        assert_eq!(tail_lines("", 3), "");
        assert_eq!(tail_lines("a\nb", 0), "");
    }

    #[test]
    fn the_log_file_is_read_whole_or_by_its_tail() {
        let dir = std::env::temp_dir().join(format!("nixe-log-t412-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // No file yet is an empty log, not an error.
        assert_eq!(read_log(&dir, None).unwrap(), "");
        std::fs::write(log_file(&dir), "one\ntwo\nthree\n").unwrap();
        assert_eq!(read_log(&dir, None).unwrap(), "one\ntwo\nthree\n");
        assert_eq!(read_log(&dir, Some(2)).unwrap(), "two\nthree");
        assert!(log_file(&dir).ends_with("nixe.log"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
