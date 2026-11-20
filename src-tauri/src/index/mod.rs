//! The persistent vault index: notes, links, tags, headings, typed properties and full text in
//! one SQLite file below the app data directory. Derived data only: it is rebuilt from the
//! vault when missing or when `SCHEMA_VERSION` changes, and nothing is ever written into the vault.

pub mod commands;
pub mod health;
pub mod read;
mod scan;
pub mod search;
pub mod watch;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

pub use read::{Backlink, NoteRecord, NoteSummary, RelatedNote, TagCount};
pub use scan::scan;
pub use search::SearchHit;

/// Bump on every schema change; a different version on disk means "drop and rebuild".
pub const SCHEMA_VERSION: i32 = 2;

const SCHEMA: &str = "
CREATE TABLE files (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL
);
CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    aliases TEXT NOT NULL,
    warnings TEXT NOT NULL
);
CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target TEXT NOT NULL,
    heading TEXT,
    block TEXT,
    alias TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('link', 'embed', 'markdown')),
    resolved TEXT,
    line INTEGER NOT NULL DEFAULT 0,
    context TEXT NOT NULL DEFAULT ''
);
CREATE INDEX links_source ON links(source_id);
CREATE INDEX links_resolved ON links(resolved);
CREATE TABLE tags (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag TEXT NOT NULL
);
CREATE INDEX tags_note ON tags(note_id);
CREATE INDEX tags_tag ON tags(tag);
CREATE TABLE headings (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    level INTEGER NOT NULL,
    text TEXT NOT NULL
);
CREATE INDEX headings_note ON headings(note_id);
CREATE TABLE properties (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL
);
CREATE INDEX properties_note ON properties(note_id);
CREATE VIRTUAL TABLE notes_fts USING fts5(body);
";

/// `<app-data>/index/<vault-hash>.sqlite` for the vault at `root`.
pub fn index_path(app_data: &Path, root: &Path) -> PathBuf {
    app_data
        .join("index")
        .join(format!("{}.sqlite", vault_hash(root)))
}

/// Stable 64-bit FNV-1a of the vault path, as 16 hex digits.
pub fn vault_hash(root: &Path) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in root.to_string_lossy().replace('\\', "/").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// How long an opener waits for a lock held by another connection.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Opens the index at `path`, creating it. A file with another schema version, or one that is
/// not a database, is deleted and created anew. Other errors (a busy database, for example)
/// are returned and never delete anything.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match try_open(path) {
        Err(e) if is_unusable(&e) => {
            remove_files(path);
            try_open(path)
        }
        other => other,
    }
}

fn is_unusable(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt)
    )
}

fn try_open(path: &Path) -> rusqlite::Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    enable_wal(&conn)?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    if read_version(&conn)? == SCHEMA_VERSION {
        return Ok(conn);
    }
    // Create (or recreate) under one write lock, so a second opener waits and then sees the
    // finished schema instead of a half-built one.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let version = read_version(&tx)?;
    if version == SCHEMA_VERSION {
        tx.commit()?;
        return Ok(conn);
    }
    drop_all(&tx)?;
    tx.execute_batch(SCHEMA)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(conn)
}

/// Switches the database to WAL. On a new file SQLite answers `database is locked` at once, without
/// calling the busy handler, when another connection opens the file at the same time (#207), so the
/// `busy_timeout` does not help here: retry for as long as it would have waited. A database that
/// is already in WAL mode accepts the pragma at any time.
fn enable_wal(conn: &Connection) -> rusqlite::Result<()> {
    let start = std::time::Instant::now();
    loop {
        match conn.pragma_update(None, "journal_mode", "WAL") {
            Err(e) if is_busy(&e) && start.elapsed() < BUSY_TIMEOUT => {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            other => return other,
        }
    }
}

fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

fn read_version(conn: &Connection) -> rusqlite::Result<i32> {
    conn.pragma_query_value(None, "user_version", |r| r.get(0))
}

/// Drops every table (and with it its indexes) of an index with an old schema.
fn drop_all(conn: &Connection) -> rusqlite::Result<()> {
    // The FTS table goes first: it takes its shadow tables with it.
    conn.execute_batch("DROP TABLE IF EXISTS notes_fts")?;
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for t in tables {
        conn.execute_batch(&format!("DROP TABLE IF EXISTS \"{t}\""))?;
    }
    Ok(())
}

fn remove_files(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut p = path.as_os_str().to_owned();
        p.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }
}

#[cfg(test)]
mod tests;
