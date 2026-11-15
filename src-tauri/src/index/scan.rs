//! Incremental scan: walks the vault and re-extracts only the notes whose mtime or size changed.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, Transaction};
use serde::Serialize;

use crate::vault::meta::{self, NoteMeta};
use crate::vault::resolve::{is_markdown_path, Resolver};
use crate::vault::{walk_vault, VaultFile};

/// Progress of a running scan; `total` is the number of notes to extract.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ScanProgress {
    pub done: usize,
    pub total: usize,
}

/// What a finished scan changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScanSummary {
    pub extracted: usize,
    pub removed: usize,
}

/// Brings the index in line with the vault at `root`. `on_progress` is called before the first
/// extraction and after each one.
pub fn scan(
    conn: &mut Connection,
    root: &Path,
    mut on_progress: impl FnMut(ScanProgress),
) -> rusqlite::Result<ScanSummary> {
    let files = walk_vault(root);

    let known: HashMap<String, (u64, i64)> = {
        let mut stmt = conn.prepare("SELECT path, size, mtime_ns FROM files")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, (r.get::<_, i64>(1)? as u64, r.get(2)?)))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let present: HashSet<&str> = files.iter().map(|f| f.path.as_str()).collect();

    let removed: Vec<&String> = known
        .keys()
        .filter(|p| !present.contains(p.as_str()))
        .collect();
    let changed: Vec<&VaultFile> = files
        .iter()
        .filter(|f| known.get(&f.path) != Some(&(f.size, f.mtime_ns)))
        .collect();
    let added = changed.iter().any(|f| !known.contains_key(&f.path));
    let to_extract: Vec<&VaultFile> = changed
        .iter()
        .copied()
        .filter(|f| is_markdown_path(&f.path))
        .collect();

    if changed.is_empty() && removed.is_empty() {
        return Ok(ScanSummary::default());
    }

    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    let resolver = Resolver::new(&paths);
    let total = to_extract.len();
    let mut progress = ScanProgress { done: 0, total };
    on_progress(progress);

    let tx = conn.transaction()?;
    for path in &removed {
        delete_note(&tx, path)?;
        tx.execute("DELETE FROM files WHERE path = ?1", [path])?;
    }
    let mut extracted_paths = HashSet::new();
    for file in &to_extract {
        // An unreadable file is skipped and retried on the next scan.
        if let Ok(bytes) = std::fs::read(root.join(&file.path)) {
            let text = String::from_utf8_lossy(&bytes);
            delete_note(&tx, &file.path)?;
            insert_note(&tx, &file.path, &text, &meta::extract(&text), &resolver)?;
            extracted_paths.insert(file.path.as_str());
        }
        progress.done += 1;
        on_progress(progress);
    }
    for file in &changed {
        if !is_markdown_path(&file.path) || extracted_paths.contains(file.path.as_str()) {
            tx.execute(
                "INSERT OR REPLACE INTO files (path, size, mtime_ns) VALUES (?1, ?2, ?3)",
                params![file.path, file.size as i64, file.mtime_ns],
            )?;
        }
    }
    if added || !removed.is_empty() {
        reresolve_all(&tx, &resolver)?;
    }
    tx.commit()?;
    Ok(ScanSummary {
        extracted: extracted_paths.len(),
        removed: removed.len(),
    })
}

fn delete_note(tx: &Transaction, path: &str) -> rusqlite::Result<()> {
    let id: Option<i64> = tx
        .query_row("SELECT id FROM notes WHERE path = ?1", [path], |r| r.get(0))
        .ok();
    if let Some(id) = id {
        tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", [id])?;
        tx.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    }
    Ok(())
}

fn insert_note(
    tx: &Transaction,
    path: &str,
    body: &str,
    meta: &NoteMeta,
    resolver: &Resolver,
) -> rusqlite::Result<()> {
    let title = path
        .rsplit('/')
        .next()
        .map(|n| n.rsplit_once('.').map_or(n, |(stem, _)| stem))
        .unwrap_or(path);
    tx.execute(
        "INSERT INTO notes (path, title, aliases, warnings) VALUES (?1, ?2, ?3, ?4)",
        params![
            path,
            title,
            serde_json::to_string(&meta.aliases).unwrap_or_default(),
            serde_json::to_string(&meta.warnings).unwrap_or_default()
        ],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO notes_fts (rowid, body) VALUES (?1, ?2)",
        params![id, body],
    )?;

    let mut link = tx.prepare_cached(
        "INSERT INTO links (source_id, target, heading, block, alias, kind, resolved)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for l in &meta.links {
        // `[[#Heading]]` points at the note itself.
        let resolved = if l.target.is_empty() {
            Some(path.to_string())
        } else {
            resolver.resolve(&l.target)
        };
        let kind = if l.embed { "embed" } else { "link" };
        link.execute(params![
            id, l.target, l.heading, l.block, l.alias, kind, resolved
        ])?;
    }
    for l in &meta.markdown_links {
        let resolved = resolver.resolve(&l.target);
        link.execute(params![
            id,
            l.target,
            l.heading,
            None::<String>,
            None::<String>,
            "markdown",
            resolved
        ])?;
    }
    let mut tag = tx.prepare_cached("INSERT INTO tags (note_id, tag) VALUES (?1, ?2)")?;
    for t in &meta.tags {
        tag.execute(params![id, t])?;
    }
    let mut heading = tx.prepare_cached(
        "INSERT INTO headings (note_id, position, level, text) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (i, h) in meta.headings.iter().enumerate() {
        heading.execute(params![id, i as i64, h.level, h.text])?;
    }
    let mut prop = tx.prepare_cached(
        "INSERT INTO properties (note_id, key, type, value) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for p in &meta.properties {
        let kind = serde_json::to_value(p.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        prop.execute(params![id, p.key, kind, p.value.to_string()])?;
    }
    Ok(())
}

/// Files appeared or vanished, so any link may now resolve differently.
fn reresolve_all(tx: &Transaction, resolver: &Resolver) -> rusqlite::Result<()> {
    let rows: Vec<(i64, String, Option<String>, String)> = {
        let mut stmt = tx.prepare(
            "SELECT l.id, l.target, l.resolved, n.path FROM links l JOIN notes n ON n.id = l.source_id",
        )?;
        let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        mapped.collect::<Result<_, _>>()?
    };
    let mut update = tx.prepare_cached("UPDATE links SET resolved = ?1 WHERE id = ?2")?;
    for (id, target, current, source) in rows {
        let now = if target.is_empty() {
            Some(source)
        } else {
            resolver.resolve(&target)
        };
        if now != current {
            update.execute(params![now, id])?;
        }
    }
    Ok(())
}
