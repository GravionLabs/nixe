//! Vault-wide change handling: maps raw file system events to `VaultChange`s and applies them
//! to the index without a full re-extraction.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;

use super::scan::{delete_note, insert_note, reresolve_all, ScanSummary};
use crate::vault::meta;
use crate::vault::resolve::{is_markdown_path, Resolver};
use crate::vault::{walk_vault, SKIPPED_DIRS};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Create,
    Modify,
    Remove,
    /// `from` of the change holds the old path.
    Rename,
}

/// One change below the vault root; paths are relative with forward slashes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VaultChange {
    pub path: String,
    pub kind: ChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

impl VaultChange {
    fn new(path: &str, kind: ChangeKind) -> Self {
        Self {
            path: path.into(),
            kind,
            from: None,
        }
    }
}

/// Suffix of the temp file the app writes before it renames it over a note.
const OWN_TEMP_SUFFIX: &str = ".nixe-tmp";

fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    if rel.is_empty() || rel.split('/').any(|c| SKIPPED_DIRS.contains(&c)) {
        return None;
    }
    // The temp file of the app's own atomic write (`write.rs`) never loops back as a change.
    if rel.ends_with(OWN_TEMP_SUFFIX) {
        return None;
    }
    Some(rel)
}

fn size_of(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| m.len())
}

fn files_below(dir: &Path, root: &Path, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = entry.path();
        if p.is_dir() {
            files_below(&p, root, out);
        } else if let Some(rel) = relative(root, &p) {
            out.push(rel);
        }
    }
}

/// Turns the paths of one debounced batch into changes. `known` maps the indexed paths to their
/// size. The disk decides the kind: a path that is gone is removed, a new one is created, a
/// known one is modified. A removed and a created file of the same size, with no other
/// candidate of that size, are reported as one rename.
pub fn map_events(root: &Path, raw: &[PathBuf], known: &HashMap<String, u64>) -> Vec<VaultChange> {
    let mut paths: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |p: String, paths: &mut Vec<String>| {
        if seen.insert(p.clone()) {
            paths.push(p);
        }
    };
    for raw_path in raw {
        let Some(rel) = relative(root, raw_path) else {
            continue;
        };
        if raw_path.is_dir() {
            let mut inner = Vec::new();
            files_below(raw_path, root, &mut inner);
            if inner.is_empty() {
                push(rel, &mut paths);
            }
            for p in inner {
                push(p, &mut paths);
            }
        } else if !raw_path.exists() {
            // A removed folder takes every indexed file below it along.
            let prefix = format!("{rel}/");
            for k in known.keys().filter(|k| k.starts_with(&prefix)) {
                push(k.clone(), &mut paths);
            }
            push(rel, &mut paths);
        } else {
            push(rel, &mut paths);
        }
    }
    paths.sort();

    let mut removed: Vec<(String, u64)> = Vec::new();
    let mut created: Vec<(String, u64)> = Vec::new();
    let mut changes = Vec::new();
    let mut folders: Vec<(String, ChangeKind)> = Vec::new();
    for p in &paths {
        match (size_of(&root.join(p)), known.get(p)) {
            (Some(size), None) => created.push((p.clone(), size)),
            (Some(_), Some(_)) => changes.push(VaultChange::new(p, ChangeKind::Modify)),
            (None, Some(size)) => removed.push((p.clone(), *size)),
            // A folder without files (new, or gone) changes the tree, not the index.
            (None, None) if root.join(p).is_dir() => folders.push((p.clone(), ChangeKind::Create)),
            (None, None) if !root.join(p).exists() => folders.push((p.clone(), ChangeKind::Remove)),
            (None, None) => {}
        }
    }
    for (path, size) in &created {
        let from: Vec<&(String, u64)> = removed.iter().filter(|(_, s)| s == size).collect();
        let same = created.iter().filter(|(_, s)| s == size).count();
        if let ([(old, _)], 1) = (from.as_slice(), same) {
            changes.push(VaultChange {
                path: path.clone(),
                kind: ChangeKind::Rename,
                from: Some(old.clone()),
            });
        } else {
            changes.push(VaultChange::new(path, ChangeKind::Create));
        }
    }
    let renamed: HashSet<String> = changes.iter().filter_map(|c| c.from.clone()).collect();
    for (path, _) in &removed {
        if !renamed.contains(path) {
            changes.push(VaultChange::new(path, ChangeKind::Remove));
        }
    }
    for (path, kind) in &folders {
        // A folder with removed files below is already reported through them.
        let prefix = format!("{path}/");
        if !changes.iter().any(|c| c.path.starts_with(&prefix)) {
            changes.push(VaultChange::new(path, *kind));
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    changes
}

/// The indexed paths and sizes, as `map_events` needs them.
pub fn known_files(conn: &Connection) -> rusqlite::Result<HashMap<String, u64>> {
    let mut stmt = conn.prepare("SELECT path, size FROM files")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u64)))?;
    rows.collect()
}

/// Applies `changes` to the index: changed notes are re-extracted, removed ones dropped and a
/// renamed one moves to its new path. Links are re-resolved when the set of files changed.
pub fn apply_changes(
    conn: &mut Connection,
    root: &Path,
    changes: &[VaultChange],
) -> rusqlite::Result<ScanSummary> {
    if changes.is_empty() {
        return Ok(ScanSummary::default());
    }
    let files = walk_vault(root);
    let present: HashMap<&str, (u64, i64)> = files
        .iter()
        .map(|f| (f.path.as_str(), (f.size, f.mtime_ns)))
        .collect();
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    let resolver = Resolver::new(&paths);

    let tx = conn.transaction()?;
    let mut summary = ScanSummary::default();
    let mut membership_changed = false;
    let mut upsert = |tx: &rusqlite::Transaction, path: &str| -> rusqlite::Result<bool> {
        let Some(&(size, mtime_ns)) = present.get(path) else {
            return Ok(false);
        };
        if is_markdown_path(path) {
            // An unreadable file is left for the next scan.
            let Ok(bytes) = std::fs::read(root.join(path)) else {
                return Ok(false);
            };
            let text = String::from_utf8_lossy(&bytes);
            delete_note(tx, path)?;
            insert_note(tx, path, &text, &meta::extract(&text), &resolver)?;
            summary.extracted += 1;
        }
        tx.execute(
            "INSERT OR REPLACE INTO files (path, size, mtime_ns) VALUES (?1, ?2, ?3)",
            params![path, size as i64, mtime_ns],
        )?;
        Ok(true)
    };
    for change in changes {
        if let Some(from) = &change.from {
            delete_note(&tx, from)?;
            tx.execute("DELETE FROM files WHERE path = ?1", [from])?;
            membership_changed = true;
        }
        match change.kind {
            ChangeKind::Remove => {
                delete_note(&tx, &change.path)?;
                let n = tx.execute("DELETE FROM files WHERE path = ?1", [&change.path])?;
                summary.removed += n;
                membership_changed = true;
            }
            ChangeKind::Create | ChangeKind::Rename => {
                membership_changed = true;
                if !upsert(&tx, &change.path)? {
                    delete_note(&tx, &change.path)?;
                    tx.execute("DELETE FROM files WHERE path = ?1", [&change.path])?;
                }
            }
            ChangeKind::Modify => {
                if !upsert(&tx, &change.path)? {
                    // Gone or ignored by now.
                    delete_note(&tx, &change.path)?;
                    summary.removed +=
                        tx.execute("DELETE FROM files WHERE path = ?1", [&change.path])?;
                    membership_changed = true;
                }
            }
        }
    }
    if membership_changed {
        reresolve_all(&tx, &resolver)?;
    }
    tx.commit()?;
    Ok(summary)
}
