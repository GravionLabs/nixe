use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager, State};

mod menu;
mod tree;

/// Event telling the frontend that a file or folder is waiting in `take_pending_file`.
const OPEN_FILE_EVENT: &str = "open-file-requested";
/// Event emitted when the watched file changed on disk (payload: path).
const FILE_CHANGED_EVENT: &str = "file-changed";

#[derive(Default)]
struct AppState {
    /// File or folder requested via CLI argument, OS file association or a second instance.
    pending_file: Mutex<Option<String>>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

/// Paths are handed to the frontend with forward slashes on every platform.
fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// First CLI argument (after the binary) that points to an existing file or folder.
fn path_from_args(args: &[String], cwd: &Path) -> Option<String> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter_map(|arg| dunce::canonicalize(cwd.join(arg)).ok())
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
    let file_dir = Path::new(&path).parent().map(Path::to_path_buf).unwrap_or_default();
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

/// Watches a single file. The parent directory is watched (non-recursively) so
/// that editors saving via "write temp file + rename" are detected as well.
#[tauri::command]
fn watch_file(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target.parent().ok_or("file has no parent directory")?.to_path_buf();
    let file_name = target.file_name().map(|n| n.to_os_string());

    let mut debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
        if let Ok(events) = res {
            if events.iter().any(|e| e.path.file_name().map(|n| n.to_os_string()) == file_name) {
                let _ = app.emit(FILE_CHANGED_EVENT, &path);
            }
        }
    })
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    // Replacing the old debouncer drops (and stops) the previous watch.
    *state.watcher.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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

    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::forward_event(app, event.id().as_ref()))
        .setup(|app| {
            let cwd = std::env::current_dir().unwrap_or_default();
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = path_from_args(&args, &cwd) {
                *app.state::<AppState>().pending_file.lock().unwrap() = Some(path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_pending_file,
            read_text_file,
            is_file,
            is_dir,
            list_dir,
            find_wiki_root,
            watch_file
        ])
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
        assert_eq!(find_wiki_root(path_to_string(&file)), path_to_string(&root.join("wiki")));
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
        let args = vec!["nixe".into(), "--verbose".into(), "missing.md".into(), "README.md".into()];
        assert_eq!(path_from_args(&args, &root), Some(path_to_string(&root.join("README.md"))));
        let args = vec!["nixe".into(), ".".into()];
        assert_eq!(path_from_args(&args, &root), Some(path_to_string(&root)));
    }
}
