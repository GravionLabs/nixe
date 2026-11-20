//! Tauri side of the index: one vault at a time, scanned on a background thread.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager, State};

use super::watch::{apply_changes, known_files, map_events};

use super::health::{self, HealthReport};
use super::read::{self, IndexStatus, UnlinkedMention};
use super::search;
use super::{index_path, open, scan, Backlink, NoteRecord, NoteSummary, SearchHit, TagCount};

/// Event carrying the `IndexStatus` whenever it changes.
pub const INDEX_EVENT: &str = "index-status";
/// Event carrying the `VaultChange`s of one debounced batch, after the index applied them.
pub const VAULT_CHANGED_EVENT: &str = "vault-changed";

#[derive(Default)]
pub struct IndexState {
    db: Mutex<Option<PathBuf>>,
    /// The status of the current scan generation; older scans cannot write it.
    status: Arc<Mutex<Tracked>>,
    /// Only one scan runs at a time; a later one waits and then finds little to do.
    scan_lock: Arc<Mutex<()>>,
    /// Watches the whole vault; replacing it stops the previous watch.
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

#[derive(Default)]
struct Tracked {
    generation: u64,
    status: Option<IndexStatus>,
}

impl IndexState {
    fn conn(&self) -> Result<rusqlite::Connection, String> {
        let db = self.db.lock().unwrap().clone();
        let db = db.ok_or("no vault is indexed yet")?;
        open(&db).map_err(|e| e.to_string())
    }
}

impl IndexState {
    /// The notes that link to any of `targets`, from the index; `None` while the index is
    /// missing or still being built (it may not know every link yet).
    pub fn referrers(&self, targets: &[String]) -> Option<Vec<String>> {
        let ready = self
            .status
            .lock()
            .unwrap()
            .status
            .as_ref()
            .is_some_and(|s| s.state == "ready");
        if !ready {
            return None;
        }
        read::referrers(&self.conn().ok()?, targets).ok()
    }
}

/// Publishes `status` unless a newer scan has started since `generation`.
fn set_status(app: &AppHandle, shared: &Mutex<Tracked>, generation: u64, status: IndexStatus) {
    let mut tracked = shared.lock().unwrap();
    if tracked.generation != generation {
        return;
    }
    tracked.status = Some(status.clone());
    let _ = app.emit(INDEX_EVENT, status);
}

/// Starts a background scan of the vault at `root` and returns at once. Call it after the first
/// note is shown. A scan already running for the same vault is left alone.
#[tauri::command]
pub fn index_start(
    app: AppHandle,
    state: State<'_, IndexState>,
    root: String,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let root = PathBuf::from(root);
    let db = index_path(&data_dir, &root);
    {
        let mut current = state.db.lock().unwrap();
        let scanning = state
            .status
            .lock()
            .unwrap()
            .status
            .as_ref()
            .is_some_and(|s| s.state == "scanning");
        if scanning && current.as_deref() == Some(db.as_path()) {
            return Ok(());
        }
        *current = Some(db.clone());
    }
    let shared = state.status.clone();
    let scan_lock = state.scan_lock.clone();
    match watch_vault(&app, &db, &root, scan_lock.clone()) {
        Ok(w) => *state.watcher.lock().unwrap() = Some(w),
        Err(e) => eprintln!("vault watcher not started: {e}"),
    }
    let generation = {
        let mut tracked = shared.lock().unwrap();
        tracked.generation += 1;
        tracked.generation
    };
    set_status(
        &app,
        &shared,
        generation,
        IndexStatus {
            state: "scanning".into(),
            ..IndexStatus::idle()
        },
    );
    std::thread::spawn(move || {
        let _one_at_a_time = scan_lock.lock().unwrap_or_else(|e| e.into_inner());
        run_scan(&app, &shared, generation, &db, &root)
    });
    Ok(())
}

/// Watches `root` recursively. Each debounced batch is mapped to changes, applied to the index
/// (after a running scan) and then announced as `vault-changed`.
fn watch_vault(
    app: &AppHandle,
    db: &Path,
    root: &Path,
    scan_lock: Arc<Mutex<()>>,
) -> Result<Debouncer<RecommendedWatcher>, String> {
    let (app, db, vault) = (app.clone(), db.to_path_buf(), root.to_path_buf());
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let raw: Vec<PathBuf> = events.into_iter().map(|e| e.path).collect();
            let _one_at_a_time = scan_lock.lock().unwrap_or_else(|e| e.into_inner());
            let Ok(mut conn) = open(&db) else { return };
            let Ok(known) = known_files(&conn) else {
                return;
            };
            let changes = map_events(&vault, &raw, &known);
            if changes.is_empty() || apply_changes(&mut conn, &vault, &changes).is_err() {
                return;
            }
            let _ = app.emit(VAULT_CHANGED_EVENT, &changes);
        },
    )
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    Ok(debouncer)
}

fn run_scan(app: &AppHandle, shared: &Mutex<Tracked>, generation: u64, db: &Path, root: &Path) {
    let outcome = open(db).and_then(|mut conn| {
        scan(&mut conn, root, |p| {
            set_status(
                app,
                shared,
                generation,
                IndexStatus {
                    state: "scanning".into(),
                    done: p.done,
                    total: p.total,
                    notes: 0,
                    error: None,
                },
            );
        })?;
        read::note_count(&conn)
    });
    let status = match outcome {
        Ok(notes) => IndexStatus {
            state: "ready".into(),
            notes,
            ..IndexStatus::idle()
        },
        Err(e) => IndexStatus {
            state: "error".into(),
            error: Some(e.to_string()),
            ..IndexStatus::idle()
        },
    };
    set_status(app, shared, generation, status);
}

#[tauri::command]
pub fn notes(state: State<'_, IndexState>) -> Result<Vec<NoteSummary>, String> {
    read::notes(&state.conn()?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn note_meta(state: State<'_, IndexState>, path: String) -> Result<Option<NoteRecord>, String> {
    read::note_meta(&state.conn()?, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn backlinks(state: State<'_, IndexState>, path: String) -> Result<Vec<Backlink>, String> {
    read::backlinks(&state.conn()?, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unlinked_mentions(
    state: State<'_, IndexState>,
    path: String,
) -> Result<Vec<UnlinkedMention>, String> {
    let conn = state.conn()?;
    tauri::async_runtime::spawn_blocking(move || {
        read::unlinked_mentions(&conn, &path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn tags(state: State<'_, IndexState>) -> Result<Vec<TagCount>, String> {
    read::tags(&state.conn()?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_notes(state: State<'_, IndexState>, query: String) -> Result<Vec<SearchHit>, String> {
    search::search(&state.conn()?, &query).map_err(|e| e.to_string())
}

/// A folder of the workspace a search or the switcher covers.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct RootArg {
    pub path: String,
    pub name: String,
}

/// A note of the workspace with the root it is in.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkspaceNote {
    pub root: String,
    #[serde(rename = "rootPath")]
    pub root_path: String,
    #[serde(flatten)]
    pub note: NoteSummary,
}

/// Brings the index of every root up to date (the scan of the first root is the window's own
/// `index_start`; for it this is an incremental pass). Returns when all are done.
#[tauri::command]
pub async fn workspace_index(
    app: AppHandle,
    state: State<'_, IndexState>,
    roots: Vec<RootArg>,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let scan_lock = state.scan_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        for root in roots {
            let _one_at_a_time = scan_lock.lock().unwrap_or_else(|e| e.into_inner());
            let path = PathBuf::from(&root.path);
            if !path.is_dir() {
                continue;
            }
            let mut conn = open(&index_path(&data_dir, &path)).map_err(|e| e.to_string())?;
            scan(&mut conn, &path, |_| {}).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Full-text search over all `roots` (#117), each hit naming its root.
#[tauri::command]
pub async fn search_workspace(
    app: AppHandle,
    roots: Vec<RootArg>,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        search_workspace_in(&data_dir, &roots, &query).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The notes of all `roots` for the quick switcher.
#[tauri::command]
pub async fn workspace_notes(
    app: AppHandle,
    roots: Vec<RootArg>,
) -> Result<Vec<WorkspaceNote>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        workspace_notes_in(&data_dir, &roots).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn search_workspace_in(
    data_dir: &Path,
    roots: &[RootArg],
    query: &str,
) -> rusqlite::Result<Vec<SearchHit>> {
    let conns = open_roots(data_dir, roots)?;
    let list: Vec<search::SearchRoot> = roots
        .iter()
        .zip(&conns)
        .map(|(r, conn)| search::SearchRoot {
            name: &r.name,
            path: &r.path,
            conn,
        })
        .collect();
    search::search_roots(&list, query)
}

pub(crate) fn workspace_notes_in(
    data_dir: &Path,
    roots: &[RootArg],
) -> rusqlite::Result<Vec<WorkspaceNote>> {
    let conns = open_roots(data_dir, roots)?;
    let mut out = Vec::new();
    for (root, conn) in roots.iter().zip(&conns) {
        for note in read::notes(conn)? {
            out.push(WorkspaceNote {
                root: root.name.clone(),
                root_path: root.path.clone(),
                note,
            });
        }
    }
    Ok(out)
}

/// The index of each root that exists; a root without a folder gets an empty one.
fn open_roots(data_dir: &Path, roots: &[RootArg]) -> rusqlite::Result<Vec<rusqlite::Connection>> {
    roots
        .iter()
        .map(|r| open(&index_path(data_dir, Path::new(&r.path))))
        .collect()
}

#[tauri::command]
pub fn vault_health(
    state: State<'_, IndexState>,
    exclude: Vec<String>,
) -> Result<HealthReport, String> {
    health::report(&state.conn()?, &exclude).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn index_status(state: State<'_, IndexState>) -> IndexStatus {
    state
        .status
        .lock()
        .unwrap()
        .status
        .clone()
        .unwrap_or_else(IndexStatus::idle)
}
