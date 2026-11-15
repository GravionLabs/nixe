//! The persistent vault index: notes, links, tags, headings, typed properties and full text in
//! one SQLite file below the app data directory. Derived data only: it is rebuilt from the
//! vault when missing or when `SCHEMA_VERSION` changes, and nothing is ever written into the vault.

pub mod commands;
mod read;
mod scan;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

pub use read::{Backlink, NoteRecord, NoteSummary, TagCount};
pub use scan::scan;

/// Bump on every schema change; a different version on disk means "drop and rebuild".
pub const SCHEMA_VERSION: i32 = 1;

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
    resolved TEXT
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

/// Opens the index at `path`, creating it. A file with another schema version (or one that is
/// not a usable database) is deleted and created anew.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match try_open(path) {
        Ok(conn) => Ok(conn),
        Err(_) if path.exists() => {
            remove_files(path);
            try_open(path)
        }
        Err(e) => Err(e),
    }
}

fn try_open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let version: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version == SCHEMA_VERSION {
        return Ok(conn);
    }
    if version != 0 {
        drop(conn);
        remove_files(path);
        return try_open(path);
    }
    conn.execute_batch(SCHEMA)?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(conn)
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
