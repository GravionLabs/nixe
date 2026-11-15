//! Tauri side of the index: one vault at a time, scanned on a background thread.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use super::read::{self, IndexStatus};
use super::{index_path, open, scan, Backlink, NoteRecord, NoteSummary, TagCount};

/// Event carrying the `IndexStatus` whenever it changes.
pub const INDEX_EVENT: &str = "index-status";

#[derive(Default)]
pub struct IndexState {
    db: Mutex<Option<PathBuf>>,
    /// The status of the current scan generation; older scans cannot write it.
    status: Arc<Mutex<Tracked>>,
    /// Only one scan runs at a time; a later one waits and then finds little to do.
    scan_lock: Arc<Mutex<()>>,
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
pub fn tags(state: State<'_, IndexState>) -> Result<Vec<TagCount>, String> {
    read::tags(&state.conn()?).map_err(|e| e.to_string())
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
