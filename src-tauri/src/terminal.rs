//! Terminal sessions (#359): a PTY per session with the shell in the vault root, desktop only.
//! The output of a session goes to the frontend as events; every session has one reader thread
//! that ends when the child exits or the session is closed.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{settings, AppState};

/// Key of the setting that turns the terminal on; off by default.
const ENABLED_KEY: &str = "terminalEnabled";
/// How long closing waits for the reader thread to end.
const JOIN_TIMEOUT: Duration = Duration::from_secs(2);

/// A program and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shell {
    pub program: String,
    pub args: Vec<String>,
}

impl Shell {
    fn new(program: &str) -> Self {
        Shell {
            program: program.into(),
            args: Vec::new(),
        }
    }
}

/// The default shell. Unix: `SHELL` when set and not empty, else `/bin/sh`. Windows: `pwsh`, then
/// `powershell`, then `cmd`; `found` tells whether a program is on the `PATH`.
pub fn detect_shell(env_shell: Option<&str>, windows: bool, found: impl Fn(&str) -> bool) -> Shell {
    if windows {
        let program = ["pwsh", "powershell"]
            .into_iter()
            .find(|p| found(p))
            .unwrap_or("cmd");
        return Shell::new(program);
    }
    match env_shell.map(str::trim).filter(|s| !s.is_empty()) {
        Some(shell) => Shell::new(shell),
        None => Shell::new("/bin/sh"),
    }
}

/// True when `name` (with the Windows executable suffixes) exists in a `PATH` directory.
fn on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        ["", ".exe", ".cmd", ".bat"]
            .iter()
            .any(|ext| dir.join(format!("{name}{ext}")).is_file())
    })
}

/// The shell of this machine.
pub fn default_shell() -> Shell {
    detect_shell(
        std::env::var("SHELL").ok().as_deref(),
        cfg!(windows),
        on_path,
    )
}

/// Whether the text of `settings.json` turns the terminal on (missing or damaged text: off).
pub fn is_enabled(settings: Option<&str>) -> bool {
    settings
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .and_then(|v| v.get(ENABLED_KEY).and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

/// What a session reports to its sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Output(Vec<u8>),
    /// The output ended: the child exited or the session was closed.
    Exit,
}

type Sink = Arc<dyn Fn(Event) + Send + Sync>;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    reader: Option<JoinHandle<()>>,
    reader_done: Arc<AtomicBool>,
    /// The reader thread waits for this before it emits; `attach` sends it. Dropped on close.
    go: Option<std::sync::mpsc::Sender<()>>,
}

/// The open sessions by id.
#[derive(Default)]
pub struct Sessions {
    next: AtomicU64,
    map: Mutex<HashMap<u64, Session>>,
}

impl Sessions {
    /// Starts `shell` in `cwd` and returns the session id.
    pub fn open(
        &self,
        shell: &Shell,
        cwd: &Path,
        rows: u16,
        cols: u16,
        sink: impl Fn(u64, Event) + Send + Sync + 'static,
    ) -> Result<u64, String> {
        let pair = native_pty_system()
            .openpty(size(rows, cols))
            .map_err(|e| format!("terminal: {e}"))?;
        let mut cmd = CommandBuilder::new(&shell.program);
        cmd.args(&shell.args);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("terminal: {}: {e}", shell.program))?;
        // The slave end must close here, else the reader never sees the end of the output.
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("terminal: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("terminal: {e}"))?;

        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let sink: Sink = Arc::new(move |event| sink(id, event));
        let done = Arc::new(AtomicBool::new(false));
        let thread_done = done.clone();
        let (go, wait) = std::sync::mpsc::channel::<()>();
        let handle = std::thread::Builder::new()
            .name(format!("terminal-{id}"))
            .spawn(move || {
                // The frontend listens only once it has the id; output before that would be lost.
                // A closed session drops the sender, which ends the wait too.
                let _ = wait.recv();
                let mut buf = [0u8; 8192];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    sink(Event::Output(buf[..n].to_vec()));
                }
                thread_done.store(true, Ordering::SeqCst);
                sink(Event::Exit);
            })
            .map_err(|e| format!("terminal: {e}"))?;
        self.map.lock().unwrap().insert(
            id,
            Session {
                master: pair.master,
                writer,
                child,
                reader: Some(handle),
                reader_done: done,
                go: Some(go),
            },
        );
        Ok(id)
    }

    /// The frontend listens now: the output of the session starts to flow.
    pub fn attach(&self, id: u64) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        let session = map.get_mut(&id).ok_or_else(|| not_open(id))?;
        if let Some(go) = session.go.take() {
            let _ = go.send(());
        }
        Ok(())
    }

    /// Sends `data` to the shell.
    pub fn write(&self, id: u64, data: &[u8]) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        let session = map.get_mut(&id).ok_or_else(|| not_open(id))?;
        session
            .writer
            .write_all(data)
            .and_then(|_| session.writer.flush())
            .map_err(|e| format!("terminal: {e}"))
    }

    pub fn resize(&self, id: u64, rows: u16, cols: u16) -> Result<(), String> {
        let map = self.map.lock().unwrap();
        let session = map.get(&id).ok_or_else(|| not_open(id))?;
        session
            .master
            .resize(size(rows, cols))
            .map_err(|e| format!("terminal: {e}"))
    }

    /// Kills the child, reaps it and frees the session; an error when it is not open.
    pub fn close(&self, id: u64) -> Result<(), String> {
        let session = self
            .map
            .lock()
            .unwrap()
            .remove(&id)
            .ok_or_else(|| not_open(id))?;
        finish(session);
        Ok(())
    }

    /// Closes every session (app exit).
    pub fn close_all(&self) {
        let sessions: Vec<Session> = self.map.lock().unwrap().drain().map(|(_, s)| s).collect();
        sessions.into_iter().for_each(finish);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }
}

fn finish(mut session: Session) {
    let _ = session.child.kill();
    let _ = session.child.wait();
    // Dropping the master ends the reader on Windows, where closing the console is what ends it.
    drop(session.writer);
    drop(session.master);
    if let Some(handle) = session.reader.take() {
        // A grandchild that keeps the terminal open could hold the reader: do not wait for ever.
        let deadline = Instant::now() + JOIN_TIMEOUT;
        while !session.reader_done.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if session.reader_done.load(Ordering::SeqCst) {
            let _ = handle.join();
        }
    }
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn not_open(id: u64) -> String {
    format!("terminal {id} is not open")
}

#[derive(Serialize, Clone)]
struct OutputPayload {
    /// Base64 of the raw bytes: a read may end inside a UTF-8 sequence.
    data: String,
}

fn ensure_enabled(app: &AppHandle) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    check_enabled(&dir)
}

/// Ok when the settings file in `dir` turns the terminal on; every command starts with it.
fn check_enabled(dir: &Path) -> Result<(), String> {
    if is_enabled(settings::read_settings(dir)?.as_deref()) {
        Ok(())
    } else {
        Err("the terminal is turned off in the settings".into())
    }
}

/// Starts the shell in the vault root; output arrives as `terminal-output-<id>` events and the
/// end as `terminal-exit-<id>`.
#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    sessions: State<'_, Sessions>,
    rows: u16,
    cols: u16,
) -> Result<u64, String> {
    ensure_enabled(&app)?;
    let root: PathBuf = crate::vault_root_of(&state)?;
    let handle = app.clone();
    sessions.open(&default_shell(), &root, rows, cols, move |id, event| {
        let _ = match event {
            Event::Output(bytes) => handle.emit(
                &format!("terminal-output-{id}"),
                OutputPayload {
                    data: base64::engine::general_purpose::STANDARD.encode(bytes),
                },
            ),
            Event::Exit => handle.emit(&format!("terminal-exit-{id}"), ()),
        };
    })
}

/// Starts the output of session `id`; call it once the listeners for its events are registered.
#[tauri::command]
pub fn terminal_attach(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    id: u64,
) -> Result<(), String> {
    ensure_enabled(&app)?;
    sessions.attach(id)
}

/// Sends input to the shell of session `id`.
#[tauri::command]
pub fn terminal_write(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    id: u64,
    data: String,
) -> Result<(), String> {
    ensure_enabled(&app)?;
    sessions.write(id, data.as_bytes())
}

#[tauri::command]
pub fn terminal_resize(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    id: u64,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    ensure_enabled(&app)?;
    sessions.resize(id, rows, cols)
}

#[tauri::command]
pub fn terminal_close(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    id: u64,
) -> Result<(), String> {
    ensure_enabled(&app)?;
    sessions.close(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn shell_from_env_else_bin_sh() {
        let none = |_: &str| false;
        assert_eq!(
            detect_shell(Some("/bin/zsh"), false, none).program,
            "/bin/zsh"
        );
        assert_eq!(detect_shell(None, false, none).program, "/bin/sh");
        assert_eq!(detect_shell(Some("  "), false, none).program, "/bin/sh");
    }

    #[test]
    fn windows_order_is_pwsh_powershell_cmd() {
        assert_eq!(detect_shell(None, true, |_| true).program, "pwsh");
        assert_eq!(
            detect_shell(None, true, |p| p == "powershell").program,
            "powershell"
        );
        assert_eq!(detect_shell(None, true, |_| false).program, "cmd");
        // SHELL is ignored on Windows.
        assert_eq!(
            detect_shell(Some("/bin/zsh"), true, |_| false).program,
            "cmd"
        );
    }

    #[test]
    fn enabled_only_by_an_explicit_true() {
        assert!(!is_enabled(None));
        assert!(!is_enabled(Some("not json")));
        assert!(!is_enabled(Some("{}")));
        assert!(!is_enabled(Some(r#"{"terminalEnabled":"yes"}"#)));
        assert!(!is_enabled(Some(r#"{"terminalEnabled":false}"#)));
        assert!(is_enabled(Some(r#"{"terminalEnabled":true}"#)));
    }

    #[test]
    fn commands_are_refused_unless_enabled_in_the_settings_file() {
        let dir = std::env::temp_dir().join(format!("nixe-term-set-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let err = check_enabled(&dir).unwrap_err();
        assert!(err.contains("turned off"), "{err}");
        settings::write_settings(&dir, r#"{"terminalEnabled":false}"#).unwrap();
        assert!(check_enabled(&dir).is_err());
        settings::write_settings(&dir, r#"{"terminalEnabled":true}"#).unwrap();
        assert!(check_enabled(&dir).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn collect(rx: &mpsc::Receiver<(u64, Event)>) -> (String, bool) {
        let mut out = Vec::new();
        let mut exited = false;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok((_, Event::Output(b))) => out.extend(b),
                Ok((_, Event::Exit)) => {
                    exited = true;
                    break;
                }
                Err(_) => {}
            }
        }
        (String::from_utf8_lossy(&out).into_owned(), exited)
    }

    fn open_sh(
        sessions: &Sessions,
        script: &str,
        cwd: &Path,
    ) -> (u64, mpsc::Receiver<(u64, Event)>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let shell = Shell {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
        };
        let id = sessions
            .open(&shell, cwd, 24, 80, move |id, e| {
                let _ = tx.lock().unwrap().send((id, e));
            })
            .unwrap();
        sessions.attach(id).unwrap();
        (id, rx)
    }

    #[cfg(unix)]
    #[test]
    fn short_lived_command_streams_output_and_ends() {
        let sessions = Sessions::default();
        let cwd = std::env::temp_dir();
        let (id, rx) = open_sh(&sessions, "echo nixe-terminal-ok", &cwd);
        let (out, exited) = collect(&rx);
        assert!(out.contains("nixe-terminal-ok"), "{out:?}");
        assert!(exited);
        sessions.close(id).unwrap();
        assert_eq!(sessions.len(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn runs_in_the_given_directory() {
        let sessions = Sessions::default();
        let dir = std::env::temp_dir().join(format!("nixe-term-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (id, rx) = open_sh(&sessions, "pwd", &dir);
        let (out, _) = collect(&rx);
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert!(out.contains(&name), "{out:?}");
        sessions.close(id).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn input_reaches_the_shell_and_resize_works() {
        let sessions = Sessions::default();
        let (id, rx) = open_sh(&sessions, "read x; echo got-$x", &std::env::temp_dir());
        sessions.resize(id, 40, 100).unwrap();
        sessions.write(id, b"abc\n").unwrap();
        let (out, _) = collect(&rx);
        assert!(out.contains("got-abc"), "{out:?}");
        sessions.close(id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn close_kills_a_running_child_and_ends_the_reader() {
        let sessions = Sessions::default();
        let (id, rx) = open_sh(&sessions, "sleep 60", &std::env::temp_dir());
        sessions.close(id).unwrap();
        let (_, exited) = collect(&rx);
        assert!(exited, "the reader thread must report the end");
        assert_eq!(sessions.len(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn closing_twice_or_writing_after_close_is_an_error() {
        let sessions = Sessions::default();
        let (id, _rx) = open_sh(&sessions, "sleep 60", &std::env::temp_dir());
        sessions.close(id).unwrap();
        assert!(sessions.close(id).is_err());
        assert!(sessions.write(id, b"x").is_err());
        assert!(sessions.resize(id, 10, 10).is_err());
        assert!(sessions.close(999).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn close_all_ends_every_session() {
        let sessions = Sessions::default();
        let (_, rx1) = open_sh(&sessions, "sleep 60", &std::env::temp_dir());
        let (_, rx2) = open_sh(&sessions, "sleep 60", &std::env::temp_dir());
        sessions.close_all();
        assert_eq!(sessions.len(), 0);
        assert!(collect(&rx1).1 && collect(&rx2).1);
    }

    #[test]
    fn unknown_program_is_an_error() {
        let sessions = Sessions::default();
        let shell = Shell::new("/nonexistent/nixe-shell");
        assert!(sessions
            .open(&shell, &std::env::temp_dir(), 24, 80, |_, _| {})
            .is_err());
    }
}
