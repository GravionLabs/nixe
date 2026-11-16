#[cfg(desktop)]
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
mod cli_install;
#[cfg(desktop)]
mod menu;
// Spike code (#58 to #60): its commands exist only in debug and mobile builds, never in a desktop release.
#[cfg(any(debug_assertions, mobile))]
mod gitsync;
mod index;
#[cfg(any(debug_assertions, mobile))]
mod notes;
mod tree;
mod vault;
mod write;

/// Event telling the frontend that a file or folder is waiting in `take_pending_file`.
const OPEN_FILE_EVENT: &str = "open-file-requested";
/// Event emitted when the watched file changed on disk (payload: path).
const FILE_CHANGED_EVENT: &str = "file-changed";

#[derive(Default)]
struct AppState {
    /// File or folder requested via CLI argument, OS file association or a second instance.
    pending_file: Mutex<Option<String>>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    /// Vault root last returned by `find_vault_root`; notes below it may be written.
    vault_root: Mutex<Option<PathBuf>>,
    /// Note last passed to `watch_file` (the open one); it and its siblings may be written.
    open_file: Mutex<Option<PathBuf>>,
}

/// Paths are handed to the frontend with forward slashes on every platform.
fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Where piped content (`nixe -`) is stored. The path is fixed because a second
/// instance only forwards its arguments, so the running one must be able to
/// find the file from the bare `-` argument.
fn stdin_file_path() -> PathBuf {
    std::env::temp_dir().join("nixe-stdin").join("stdin.md")
}

/// Smoke-test document shown on mobile, where there is no CLI or file association yet.
/// Writes `BUNDLED_FIXTURE` below `dir` and returns its path.
#[cfg(any(mobile, test))]
fn write_bundled_fixture(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("ios.md");
    std::fs::write(&path, include_str!("../../fixtures/ios.md"))?;
    Ok(path)
}

/// Reads piped Markdown into `stdin_file_path()`. Does nothing for a terminal stdin.
#[cfg(desktop)]
fn capture_stdin(args: &[String]) {
    if !args.iter().skip(1).any(|arg| arg == "-") || std::io::stdin().is_terminal() {
        return;
    }
    let mut content = Vec::new();
    if std::io::stdin().read_to_end(&mut content).is_err() {
        return;
    }
    let path = stdin_file_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, content);
}

/// First CLI argument (after the binary) that points to an existing file or folder.
/// `-` stands for the captured stdin content.
fn path_from_args(args: &[String], cwd: &Path) -> Option<String> {
    args.iter()
        .skip(1)
        .filter_map(|arg| match arg.as_str() {
            "-" => Some(stdin_file_path()),
            _ if arg.starts_with('-') => None,
            _ => dunce::canonicalize(cwd.join(arg)).ok(),
        })
        .find(|path| path.exists())
        .map(|path| path_to_string(&path))
}

fn queue_file(app: &AppHandle, path: String) {
    *app.state::<AppState>().pending_file.lock().unwrap() = Some(path);
    let _ = app.emit(OPEN_FILE_EVENT, ());
}

#[tauri::command]
fn take_pending_file(state: State<'_, AppState>) -> Option<String> {
    state.pending_file.lock().unwrap().take()
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Atomically writes a note. The backend decides what may be written: a Markdown file below the
/// vault root, or one in the folder of the open note. The caller cannot name the root.
#[tauri::command]
fn write_text_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let vault = state.vault_root.lock().unwrap().clone();
    let open = state.open_file.lock().unwrap().clone();
    let root = write::write_root(vault.as_deref(), open.as_deref(), Path::new(&path))?;
    write::write_text_file(&root, Path::new(&path), &content)
}

/// False when the file holds bytes that are not UTF-8 (`read_text_file` would replace them).
#[tauri::command]
fn is_utf8_file(path: String) -> bool {
    std::fs::read(&path).is_ok_and(|bytes| std::str::from_utf8(&bytes).is_ok())
}

#[tauri::command]
fn is_file(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
fn is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<tree::DirEntry>, String> {
    tree::list_dir(Path::new(&path))
}

/// Root directory for wiki-absolute links ("/Page/Sub-Page").
///
/// Azure DevOps wikis keep a `.order` file in every folder, so the root is the
/// topmost directory of the contiguous `.order` chain. A `.git` directory stops
/// the search. Without any markers the file's own directory is used.
#[tauri::command]
fn find_wiki_root(path: String) -> String {
    let file_dir = Path::new(&path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let mut last_order_dir: Option<PathBuf> = None;

    for dir in file_dir.ancestors() {
        let has_order = dir.join(".order").is_file();
        if has_order {
            last_order_dir = Some(dir.to_path_buf());
        } else if last_order_dir.is_some() {
            break;
        }
        if dir.join(".git").exists() {
            return path_to_string(last_order_dir.as_deref().unwrap_or(dir));
        }
    }
    path_to_string(last_order_dir.as_deref().unwrap_or(&file_dir))
}

/// Vault root for an opened file or folder: the topmost ancestor containing `.obsidian/`,
/// else the opened folder. Read-only.
#[tauri::command]
fn find_vault_root(state: State<'_, AppState>, path: String) -> String {
    let root = vault::find_vault_root(Path::new(&path));
    *state.vault_root.lock().unwrap() = dunce::canonicalize(&root).ok();
    path_to_string(&root)
}

/// All files below the vault root (relative, forward slashes), see `vault::list_vault_files`.
#[tauri::command]
fn list_vault_files(root: String) -> Vec<String> {
    vault::list_vault_files(Path::new(&root))
}

/// Watches a single file. The parent directory is watched (non-recursively) so
/// that editors saving via "write temp file + rename" are detected as well.
#[tauri::command]
fn watch_file(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .ok_or("file has no parent directory")?
        .to_path_buf();
    let file_name = target.file_name().map(|n| n.to_os_string());

    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                if events
                    .iter()
                    .any(|e| e.path.file_name().map(|n| n.to_os_string()) == file_name)
                {
                    let _ = app.emit(FILE_CHANGED_EVENT, &path);
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    *state.open_file.lock().unwrap() = dunce::canonicalize(&target).ok();

    // Replacing the old debouncer drops (and stops) the previous watch.
    *state.watcher.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must happen before the single-instance plugin hands control to a running instance.
    #[cfg(desktop)]
    capture_stdin(&std::env::args().collect::<Vec<_>>());

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Must be the first plugin: forwards files from a second launch.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(path) = path_from_args(&argv, Path::new(&cwd)) {
                queue_file(app, path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(index::commands::IndexState::default());

    #[cfg(desktop)]
    {
        builder = builder.menu(menu::build).on_menu_event(|app, event| {
            #[cfg(target_os = "macos")]
            if event.id().as_ref() == menu::INSTALL_CLI_ID {
                return cli_install::run(app);
            }
            menu::forward_event(app, event.id().as_ref())
        });
    }

    let builder = builder.setup(|app| {
        let cwd = std::env::current_dir().unwrap_or_default();
        let args: Vec<String> = std::env::args().collect();
        if let Some(path) = path_from_args(&args, &cwd) {
            *app.state::<AppState>().pending_file.lock().unwrap() = Some(path);
        }
        #[cfg(mobile)]
        if app
            .state::<AppState>()
            .pending_file
            .lock()
            .unwrap()
            .is_none()
        {
            if let Ok(dir) = app.path().app_cache_dir() {
                if let Ok(path) = write_bundled_fixture(&dir) {
                    *app.state::<AppState>().pending_file.lock().unwrap() =
                        Some(path_to_string(&path));
                }
            }
        }
        Ok(())
    });

    // Spike commands (#58 to #60) are reachable only in debug and mobile builds.
    #[cfg(any(debug_assertions, mobile))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        take_pending_file,
        read_text_file,
        write_text_file,
        is_utf8_file,
        is_file,
        is_dir,
        list_dir,
        find_wiki_root,
        find_vault_root,
        list_vault_files,
        index::commands::index_start,
        index::commands::index_status,
        index::commands::notes,
        index::commands::note_meta,
        index::commands::backlinks,
        index::commands::tags,
        index::commands::search_notes,
        watch_file,
        gitsync::git_token_set,
        gitsync::git_token_get,
        gitsync::git_clone,
        gitsync::git_spike_edit,
        gitsync::git_commit,
        gitsync::git_pull_rebase,
        gitsync::git_push,
        notes::notes_list,
        notes::notes_read,
        notes::notes_write,
        notes::spike_external_path,
        notes::spike_external_read,
        notes::spike_external_write
    ]);
    #[cfg(not(any(debug_assertions, mobile)))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        take_pending_file,
        read_text_file,
        write_text_file,
        is_utf8_file,
        is_file,
        is_dir,
        list_dir,
        find_wiki_root,
        find_vault_root,
        list_vault_files,
        index::commands::index_start,
        index::commands::index_status,
        index::commands::notes,
        index::commands::note_meta,
        index::commands::backlinks,
        index::commands::tags,
        index::commands::search_notes,
        watch_file
    ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building nixe");

    app.run(|_app, _event| {
        // macOS delivers files opened via Finder / file association as an event.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            if let Some(path) = urls.iter().find_map(|url| url.to_file_path().ok()) {
                queue_file(_app, path_to_string(&path));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    #[test]
    fn wiki_root_is_topmost_order_dir() {
        let root = temp_dir("order");
        let sub = root.join("wiki").join("Architektur");
        fs::create_dir_all(&sub).unwrap();
        fs::write(root.join("wiki/.order"), "").unwrap();
        fs::write(sub.join(".order"), "").unwrap();
        let file = sub.join("Overview.md");
        assert_eq!(
            find_wiki_root(path_to_string(&file)),
            path_to_string(&root.join("wiki"))
        );
    }

    #[test]
    fn wiki_root_stops_at_git_dir() {
        let root = temp_dir("git");
        let sub = root.join("docs");
        fs::create_dir_all(sub.join("deep")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        let file = sub.join("deep/a.md");
        assert_eq!(find_wiki_root(path_to_string(&file)), path_to_string(&root));
    }

    #[test]
    fn cli_args_resolve_relative_files() {
        let root = temp_dir("args");
        fs::write(root.join("README.md"), "# hi").unwrap();
        let args = vec![
            "nixe".into(),
            "--verbose".into(),
            "missing.md".into(),
            "README.md".into(),
        ];
        assert_eq!(
            path_from_args(&args, &root),
            Some(path_to_string(&root.join("README.md")))
        );
        let args = vec!["nixe".into(), ".".into()];
        assert_eq!(path_from_args(&args, &root), Some(path_to_string(&root)));
    }

    #[test]
    fn dash_argument_resolves_to_captured_stdin() {
        let args = vec!["nixe".into(), "-".into()];
        let expected = stdin_file_path();
        fs::create_dir_all(expected.parent().unwrap()).unwrap();
        fs::write(&expected, "# piped").unwrap();
        assert_eq!(
            path_from_args(&args, Path::new("/")),
            Some(path_to_string(&expected))
        );
    }

    #[test]
    fn bundled_fixture_contains_mermaid_and_math() {
        let dir = temp_dir("fixture").join("cache");
        let path = write_bundled_fixture(&dir).unwrap();
        let text = fs::read_to_string(path).unwrap();
        assert!(text.contains("```mermaid"));
        assert!(text.contains("$$"));
    }
}
