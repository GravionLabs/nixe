//! The vault health report: broken links, orphan notes, duplicate basenames and unused
//! attachments, all computed from the index with a few queries (no file is read).

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::Serialize;

use crate::links::dead::LinkNote;
use crate::vault::resolve::is_markdown_path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BrokenLink {
    /// The note containing the link.
    pub source: String,
    /// 1-based line of the link in the source note.
    pub line: usize,
    /// The link target as written (`Missing` in `[[Missing#Heading]]`).
    pub target: String,
    /// `link`, `embed` or `markdown`.
    pub kind: String,
    /// The trimmed text of the line holding the link.
    pub context: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoteRef {
    pub path: String,
    pub title: String,
}

/// Notes sharing one basename (case-insensitive), so `[[name]]` cannot pick one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DuplicateGroup {
    pub name: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// Links that resolve to no file: the target is missing or ambiguous.
    pub broken_links: Vec<BrokenLink>,
    /// Notes without any link to or from another note. Daily notes never count.
    pub orphans: Vec<NoteRef>,
    pub duplicates: Vec<DuplicateGroup>,
    /// Vault-relative paths of non-Markdown files no note links or embeds.
    pub unused_attachments: Vec<String>,
}

/// True when `path` is `folder` or lies below it (`folder` is vault-relative; slashes at
/// either end are ignored).
fn in_folder(path: &str, folder: &str) -> bool {
    let folder = folder.trim_matches('/');
    let folder = folder.strip_prefix("./").unwrap_or(folder);
    !folder.is_empty()
        && path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// `YYYY-MM-DD`, the default name of a daily note.
fn is_daily_note(title: &str) -> bool {
    let b = title.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

fn is_hidden(path: &str) -> bool {
    path.split('/').any(|part| part.starts_with('.'))
}

/// The report for the indexed vault. Paths in a folder of `exclude` (vault-relative, for
/// example templates or an archive) are left out of every list.
pub fn report(conn: &Connection, exclude: &[String]) -> rusqlite::Result<HealthReport> {
    let excluded = |path: &str| exclude.iter().any(|f| in_folder(path, f));
    let mut out = HealthReport::default();

    let mut stmt = conn.prepare(
        "SELECT n.path, l.line, l.target, l.kind, l.context
         FROM links l JOIN notes n ON n.id = l.source_id
         WHERE l.resolved IS NULL ORDER BY n.path, l.line, l.id",
    )?;
    for row in stmt.query_map([], |r| {
        Ok(BrokenLink {
            source: r.get(0)?,
            line: r.get::<_, i64>(1)? as usize,
            target: r.get(2)?,
            kind: r.get(3)?,
            context: r.get(4)?,
        })
    })? {
        let link = row?;
        if !excluded(&link.source) {
            out.broken_links.push(link);
        }
    }

    // No link out (self links do not count) and none in from another note.
    let mut stmt = conn.prepare(
        "SELECT n.path, n.title FROM notes n
         WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.source_id = n.id AND l.resolved IS NOT n.path)
           AND NOT EXISTS (SELECT 1 FROM links l WHERE l.resolved = n.path AND l.source_id <> n.id)
         ORDER BY n.path",
    )?;
    for row in stmt.query_map([], |r| {
        Ok(NoteRef {
            path: r.get(0)?,
            title: r.get(1)?,
        })
    })? {
        let note = row?;
        if !excluded(&note.path) && !is_daily_note(&note.title) {
            out.orphans.push(note);
        }
    }

    let mut by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut stmt = conn.prepare("SELECT path, title FROM notes ORDER BY path")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (path, title) = row?;
        if !excluded(&path) {
            by_name.entry(title.to_lowercase()).or_default().push(path);
        }
    }
    out.duplicates = by_name
        .into_values()
        .filter(|paths| paths.len() > 1)
        .map(|paths| DuplicateGroup {
            name: paths[0]
                .rsplit('/')
                .next()
                .and_then(|n| n.rsplit_once('.').map(|(stem, _)| stem))
                .unwrap_or(&paths[0])
                .to_string(),
            paths,
        })
        .collect();

    let mut stmt = conn.prepare(
        "SELECT f.path FROM files f
         WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.resolved = f.path) ORDER BY f.path",
    )?;
    for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
        let path = row?;
        if !is_markdown_path(&path) && !is_hidden(&path) && !excluded(&path) {
            out.unused_attachments.push(path);
        }
    }
    Ok(out)
}

/// The `type: link` notes with their `url` property (see `docs/links.md`), outside the
/// `exclude` folders, sorted by path. A note without a URL is left out.
pub fn link_notes(conn: &Connection, exclude: &[String]) -> rusqlite::Result<Vec<LinkNote>> {
    let mut stmt = conn.prepare(
        "SELECT n.path, t.value, u.value FROM notes n
         JOIN properties t ON t.note_id = n.id AND lower(t.key) = 'type'
         JOIN properties u ON u.note_id = n.id AND lower(u.key) = 'url'
         ORDER BY n.path, u.rowid",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut out: Vec<LinkNote> = Vec::new();
    for row in rows {
        let (path, kind, raw) = row?;
        let text = |raw: &str| serde_json::from_str::<String>(raw).unwrap_or_default();
        let url = text(&raw).trim().to_string();
        if text(&kind) != "link"
            || url.is_empty()
            || excluded_path(&path, exclude)
            || out.last().is_some_and(|l| l.path == path)
        {
            continue;
        }
        out.push(LinkNote { path, url });
    }
    Ok(out)
}

fn excluded_path(path: &str, exclude: &[String]) -> bool {
    exclude.iter().any(|f| in_folder(path, f))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_match_whole_path_segments() {
        assert!(in_folder("archive/a.md", "archive"));
        assert!(in_folder("archive/x/a.md", "archive/"));
        assert!(in_folder("archive/a.md", "./archive"));
        assert!(!in_folder("archive2/a.md", "archive"));
        assert!(!in_folder("a.md", ""));
        assert!(!in_folder("a.md", "/"));
    }

    #[test]
    fn daily_notes_are_dated_names() {
        assert!(is_daily_note("2026-11-16"));
        assert!(!is_daily_note("2026-11-1"));
        assert!(!is_daily_note("2026_11_16"));
        assert!(!is_daily_note("Meeting 2026-11-16"));
    }
}
