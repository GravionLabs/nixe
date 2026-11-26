//! Read side of the index: what the commands return.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoteSummary {
    pub path: String,
    pub title: String,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexedLink {
    pub target: String,
    pub heading: Option<String>,
    pub block: Option<String>,
    pub alias: Option<String>,
    /// `link`, `embed` or `markdown`.
    pub kind: String,
    /// Vault-relative path of the target, `None` when missing or ambiguous.
    pub resolved: Option<String>,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexedHeading {
    pub level: u8,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IndexedProperty {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NoteRecord {
    pub path: String,
    pub title: String,
    pub aliases: Vec<String>,
    pub warnings: Vec<String>,
    pub links: Vec<IndexedLink>,
    pub tags: Vec<String>,
    pub headings: Vec<IndexedHeading>,
    pub properties: Vec<IndexedProperty>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Backlink {
    /// The note containing the link.
    pub source: String,
    pub heading: Option<String>,
    pub block: Option<String>,
    pub alias: Option<String>,
    pub kind: String,
    /// 1-based line of the link in the source note.
    pub line: usize,
    /// The trimmed text of that line.
    pub context: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

/// `state` is `idle` (no vault), `scanning`, `ready` or `error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IndexStatus {
    pub state: String,
    pub done: usize,
    pub total: usize,
    pub notes: usize,
    pub error: Option<String>,
}

impl IndexStatus {
    pub fn idle() -> Self {
        IndexStatus {
            state: "idle".into(),
            done: 0,
            total: 0,
            notes: 0,
            error: None,
        }
    }
}

pub fn notes(conn: &Connection) -> rusqlite::Result<Vec<NoteSummary>> {
    let mut stmt = conn.prepare("SELECT path, title, aliases FROM notes ORDER BY path")?;
    let rows = stmt.query_map([], |r| {
        let aliases: String = r.get(2)?;
        Ok(NoteSummary {
            path: r.get(0)?,
            title: r.get(1)?,
            aliases: serde_json::from_str(&aliases).unwrap_or_default(),
        })
    })?;
    rows.collect()
}

pub fn note_count(conn: &Connection) -> rusqlite::Result<usize> {
    conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
        .map(|n| n as usize)
}

pub fn note_meta(conn: &Connection, path: &str) -> rusqlite::Result<Option<NoteRecord>> {
    let row = conn
        .query_row(
            "SELECT id, title, aliases, warnings FROM notes WHERE path = ?1",
            [path],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((id, title, aliases, warnings)) = row else {
        return Ok(None);
    };
    let links = conn
        .prepare("SELECT target, heading, block, alias, kind, resolved, line FROM links WHERE source_id = ?1 ORDER BY id")?
        .query_map([id], |r| {
            Ok(IndexedLink {
                target: r.get(0)?,
                heading: r.get(1)?,
                block: r.get(2)?,
                alias: r.get(3)?,
                kind: r.get(4)?,
                resolved: r.get(5)?,
                line: r.get::<_, i64>(6)? as usize,
            })
        })?
        .collect::<Result<_, _>>()?;
    let tags = conn
        .prepare("SELECT tag FROM tags WHERE note_id = ?1 ORDER BY rowid")?
        .query_map([id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let headings = conn
        .prepare("SELECT level, text FROM headings WHERE note_id = ?1 ORDER BY position")?
        .query_map([id], |r| {
            Ok(IndexedHeading {
                level: r.get(0)?,
                text: r.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let properties = conn
        .prepare("SELECT key, type, value FROM properties WHERE note_id = ?1 ORDER BY rowid")?
        .query_map([id], |r| {
            let value: String = r.get(2)?;
            Ok(IndexedProperty {
                key: r.get(0)?,
                kind: r.get(1)?,
                value: serde_json::from_str(&value).unwrap_or(Value::Null),
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Some(NoteRecord {
        path: path.to_string(),
        title,
        aliases: serde_json::from_str(&aliases).unwrap_or_default(),
        warnings: serde_json::from_str(&warnings).unwrap_or_default(),
        links,
        tags,
        headings,
        properties,
    }))
}

/// A link or embed of a note, as the bases query it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteLink {
    /// The target as written; empty for a link to the note itself.
    pub target: String,
    /// Vault-relative path of the target, `None` when missing or ambiguous.
    pub resolved: Option<String>,
    pub embed: bool,
}

/// A note with everything the bases filter and show.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NoteFile {
    pub path: String,
    pub title: String,
    pub size: u64,
    pub ctime_ns: i64,
    pub mtime_ns: i64,
    /// In the order of the frontmatter.
    pub properties: Vec<IndexedProperty>,
    pub tags: Vec<String>,
    /// In document order, wikilinks before Markdown links.
    pub links: Vec<NoteLink>,
    /// The other notes that link to or embed this one, sorted.
    pub backlinks: Vec<String>,
}

/// What a base is answered from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BaseNotes {
    /// Every note, sorted by path.
    pub notes: Vec<NoteFile>,
    /// The path of every file of the vault, sorted.
    pub files: Vec<String>,
}

/// Every note with its file data, properties, tags and links.
pub fn base_notes(conn: &Connection) -> rusqlite::Result<BaseNotes> {
    // One transaction, so every statement sees the same state of the index.
    let tx = conn.unchecked_transaction()?;
    let files = tx
        .prepare("SELECT path FROM files ORDER BY path")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;

    let mut notes: Vec<NoteFile> = Vec::new();
    // Row id and path of a note to its position in `notes`.
    let mut by_id: HashMap<i64, usize> = HashMap::new();
    let mut by_path: HashMap<String, usize> = HashMap::new();
    let mut stmt = tx.prepare(
        "SELECT n.id, n.path, n.title, f.size, f.ctime_ns, f.mtime_ns
         FROM notes n JOIN files f ON f.path = n.path ORDER BY n.path",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let path: String = row.get(1)?;
        by_id.insert(row.get(0)?, notes.len());
        by_path.insert(path.clone(), notes.len());
        notes.push(NoteFile {
            path,
            title: row.get(2)?,
            size: row.get::<_, i64>(3)? as u64,
            ctime_ns: row.get(4)?,
            mtime_ns: row.get(5)?,
            ..NoteFile::default()
        });
    }

    let mut stmt = tx.prepare("SELECT note_id, key, type, value FROM properties ORDER BY rowid")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        if let Some(&i) = by_id.get(&row.get(0)?) {
            let value: String = row.get(3)?;
            notes[i].properties.push(IndexedProperty {
                key: row.get(1)?,
                kind: row.get(2)?,
                value: serde_json::from_str(&value).unwrap_or(Value::Null),
            });
        }
    }

    let mut stmt = tx.prepare("SELECT note_id, tag FROM tags ORDER BY rowid")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        if let Some(&i) = by_id.get(&row.get(0)?) {
            notes[i].tags.push(row.get(1)?);
        }
    }

    let mut stmt = tx.prepare("SELECT source_id, target, resolved, kind FROM links ORDER BY id")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let Some(&source) = by_id.get(&row.get(0)?) else {
            continue;
        };
        let link = NoteLink {
            target: row.get(1)?,
            resolved: row.get(2)?,
            embed: row.get::<_, String>(3)? == "embed",
        };
        if let Some(&target) = link.resolved.as_ref().and_then(|p| by_path.get(p)) {
            if target != source {
                let from = notes[source].path.clone();
                notes[target].backlinks.push(from);
            }
        }
        notes[source].links.push(link);
    }
    for note in &mut notes {
        note.backlinks.sort();
        note.backlinks.dedup();
    }
    Ok(BaseNotes { notes, files })
}

/// A file that is no indexed note, like a `.base` file, with what the index knows of it: its
/// data and the notes that link to or embed it. An unknown file has its path alone.
pub fn base_file(conn: &Connection, path: &str) -> rusqlite::Result<NoteFile> {
    let name = path.rsplit_once('/').map_or(path, |(_, name)| name);
    let mut file = NoteFile {
        path: path.to_string(),
        title: name.rsplit_once('.').map_or(name, |(stem, _)| stem).into(),
        ..NoteFile::default()
    };
    let data = conn
        .query_row(
            "SELECT size, ctime_ns, mtime_ns FROM files WHERE path = ?1",
            params![path],
            |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((size, ctime_ns, mtime_ns)) = data {
        (file.size, file.ctime_ns, file.mtime_ns) = (size as u64, ctime_ns, mtime_ns);
    }
    file.backlinks = conn
        .prepare(
            "SELECT DISTINCT n.path FROM links l JOIN notes n ON n.id = l.source_id
             WHERE l.resolved = ?1 AND n.path <> ?1 ORDER BY n.path",
        )?
        .query_map(params![path], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(file)
}

/// Links whose resolved target is `path`, a note linking to itself excluded.
pub fn backlinks(conn: &Connection, path: &str) -> rusqlite::Result<Vec<Backlink>> {
    let mut stmt = conn.prepare(
        "SELECT n.path, l.heading, l.block, l.alias, l.kind, l.line, l.context
         FROM links l JOIN notes n ON n.id = l.source_id
         WHERE l.resolved = ?1 AND n.path <> ?1
         ORDER BY n.path, l.id",
    )?;
    let rows = stmt.query_map(params![path], |r| {
        Ok(Backlink {
            source: r.get(0)?,
            heading: r.get(1)?,
            block: r.get(2)?,
            alias: r.get(3)?,
            kind: r.get(4)?,
            line: r.get::<_, i64>(5)? as usize,
            context: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// A note close to the open one, with the reasons it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RelatedNote {
    pub path: String,
    pub title: String,
    pub score: u32,
    /// Why the note is related, strongest first: `links both ways`, `links here`, `linked from
    /// here`, `both linked from X`, `2 shared tags`.
    pub reasons: Vec<String>,
}

const SCORE_BOTH_WAYS: u32 = 100;
const SCORE_BACKLINK: u32 = 60;
const SCORE_OUTGOING: u32 = 50;
const SCORE_CO_LINKED: u32 = 15;
const SCORE_SHARED_TAG: u32 = 5;
/// Most entries `related` returns.
pub const RELATED_LIMIT: usize = 50;

#[derive(Default)]
struct Closeness {
    backlink: bool,
    outgoing: bool,
    /// Notes that link to both the open note and this one.
    co_linkers: BTreeSet<String>,
    shared_tags: u32,
}

/// Notes close to `path`, nearest first: linked in both directions, backlinks, outgoing links,
/// notes linked from the same notes as `path`, notes sharing tags. Each carries its score and the
/// reasons; ties are ordered by path. At most `RELATED_LIMIT` entries.
pub fn related(conn: &Connection, path: &str) -> rusqlite::Result<Vec<RelatedNote>> {
    let mut found: HashMap<String, Closeness> = HashMap::new();

    let mut stmt = conn.prepare(
        "SELECT DISTINCT l.resolved FROM links l JOIN notes n ON n.id = l.source_id
         WHERE n.path = ?1 AND l.resolved IS NOT NULL AND l.resolved <> ?1",
    )?;
    for row in stmt.query_map([path], |r| r.get::<_, String>(0))? {
        found.entry(row?).or_default().outgoing = true;
    }

    let mut stmt = conn.prepare(
        "SELECT DISTINCT n.path FROM links l JOIN notes n ON n.id = l.source_id
         WHERE l.resolved = ?1 AND n.path <> ?1",
    )?;
    for row in stmt.query_map([path], |r| r.get::<_, String>(0))? {
        found.entry(row?).or_default().backlink = true;
    }

    // Notes that a linking note points to besides this one.
    let mut stmt = conn.prepare(
        "SELECT DISTINCT n.path, l2.resolved
         FROM links l1 JOIN notes n ON n.id = l1.source_id
         JOIN links l2 ON l2.source_id = l1.source_id
         WHERE l1.resolved = ?1 AND n.path <> ?1
           AND l2.resolved IS NOT NULL AND l2.resolved <> ?1
         ORDER BY n.path",
    )?;
    for row in stmt.query_map([path], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (linker, other) = row?;
        found.entry(other).or_default().co_linkers.insert(linker);
    }

    let mut stmt = conn.prepare(
        "SELECT n2.path, COUNT(DISTINCT t2.tag)
         FROM notes n1 JOIN tags t1 ON t1.note_id = n1.id
         JOIN tags t2 ON t2.tag = t1.tag
         JOIN notes n2 ON n2.id = t2.note_id
         WHERE n1.path = ?1 AND n2.path <> ?1
         GROUP BY n2.path",
    )?;
    for row in stmt.query_map([path], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })? {
        let (other, count) = row?;
        found.entry(other).or_default().shared_tags = count as u32;
    }

    let mut title_stmt = conn.prepare_cached("SELECT title FROM notes WHERE path = ?1")?;
    let mut title_of = |p: &str| -> rusqlite::Result<Option<String>> {
        title_stmt.query_row([p], |r| r.get(0)).optional()
    };

    let mut out = Vec::new();
    for (other, c) in found {
        // A link target that is no note (an attachment, say) has no title: not listed.
        let Some(title) = title_of(&other)? else {
            continue;
        };
        let mut score = 0;
        let mut reasons = Vec::new();
        if c.backlink && c.outgoing {
            score += SCORE_BOTH_WAYS;
            reasons.push("links both ways".to_string());
        } else if c.backlink {
            score += SCORE_BACKLINK;
            reasons.push("links here".to_string());
        } else if c.outgoing {
            score += SCORE_OUTGOING;
            reasons.push("linked from here".to_string());
        }
        if let Some(first) = c.co_linkers.iter().next() {
            score += SCORE_CO_LINKED * c.co_linkers.len().min(3) as u32;
            let name = title_of(first)?.unwrap_or_else(|| first.clone());
            reasons.push(match c.co_linkers.len() {
                1 => format!("both linked from {name}"),
                n => format!("both linked from {name} and {} more", n - 1),
            });
        }
        if c.shared_tags > 0 {
            score += SCORE_SHARED_TAG * c.shared_tags.min(5);
            reasons.push(match c.shared_tags {
                1 => "1 shared tag".to_string(),
                n => format!("{n} shared tags"),
            });
        }
        if reasons.is_empty() {
            continue;
        }
        out.push(RelatedNote {
            path: other,
            title,
            score,
            reasons,
        });
    }
    out.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    out.truncate(RELATED_LIMIT);
    Ok(out)
}

/// A plain-text mention of a note's title or alias in another note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnlinkedMention {
    /// The note holding the mention.
    pub source: String,
    /// 1-based line.
    pub line: usize,
    /// Byte range of the mention in that line.
    pub start: usize,
    pub end: usize,
    /// The trimmed line.
    pub context: String,
    /// The mention as written.
    pub text: String,
}

/// Mentions of the title or an alias of `path` in the other notes, as plain text: not inside code,
/// comments, frontmatter or a link. Reads the note bodies kept for full text search.
pub fn unlinked_mentions(conn: &Connection, path: &str) -> rusqlite::Result<Vec<UnlinkedMention>> {
    let Some((title, aliases)) = conn
        .query_row(
            "SELECT title, aliases FROM notes WHERE path = ?1",
            [path],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    else {
        return Ok(Vec::new());
    };
    let mut terms = vec![title];
    terms.extend(serde_json::from_str::<Vec<String>>(&aliases).unwrap_or_default());
    let mut stmt = conn.prepare(
        "SELECT n.path, f.body FROM notes n JOIN notes_fts f ON f.rowid = n.id
         WHERE n.path <> ?1 ORDER BY n.path",
    )?;
    let mut rows = stmt.query([path])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let (source, body): (String, String) = (row.get(0)?, row.get(1)?);
        for m in crate::vault::mentions::find(&body, &terms) {
            out.push(UnlinkedMention {
                source: source.clone(),
                line: m.line,
                start: m.start,
                end: m.end,
                context: m.context,
                text: m.text,
            });
        }
    }
    Ok(out)
}

/// The notes that link to any of `paths` (resolved targets), each once, sorted. Includes notes
/// that link to themselves.
pub fn referrers(conn: &Connection, paths: &[String]) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT n.path FROM links l JOIN notes n ON n.id = l.source_id WHERE l.resolved = ?1",
    )?;
    let mut out = std::collections::BTreeSet::new();
    for path in paths {
        for row in stmt.query_map(params![path], |r| r.get::<_, String>(0))? {
            out.insert(row?);
        }
    }
    Ok(out.into_iter().collect())
}

/// A note holding a property, with that property's typed value.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PropertyMatch {
    pub path: String,
    pub title: String,
    pub value: Value,
}

/// True when `value` equals `wanted` (case-insensitive, compared as text) or, for a list,
/// contains it.
fn value_matches(value: &Value, wanted: &str) -> bool {
    let wanted = wanted.to_lowercase();
    match value {
        Value::Array(items) => items.iter().any(|v| value_matches(v, &wanted)),
        Value::String(s) => s.to_lowercase() == wanted,
        Value::Null => false,
        other => other.to_string().to_lowercase() == wanted,
    }
}

/// Notes with the frontmatter property `key` (case-insensitive), sorted by path. With `value`,
/// only those whose value equals it or, for a list property, contains it.
pub fn notes_by_property(
    conn: &Connection,
    key: &str,
    value: Option<&str>,
) -> rusqlite::Result<Vec<PropertyMatch>> {
    let mut stmt = conn.prepare(
        "SELECT n.path, n.title, p.value FROM properties p JOIN notes n ON n.id = p.note_id
         WHERE lower(p.key) = lower(?1) ORDER BY n.path, p.rowid",
    )?;
    let rows = stmt.query_map([key], |r| {
        let raw: String = r.get(2)?;
        Ok(PropertyMatch {
            path: r.get(0)?,
            title: r.get(1)?,
            value: serde_json::from_str(&raw).unwrap_or(Value::Null),
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        let row = row?;
        if value.is_none_or(|w| value_matches(&row.value, w)) {
            out.push(row);
        }
    }
    Ok(out)
}

/// The paths of the `type: link` notes whose `url`, run through `normalize`, equals `wanted`
/// (already normalized), sorted. Notes saved before the normal form existed match as well.
pub fn link_notes_by_url(
    conn: &Connection,
    wanted: &str,
    normalize: impl Fn(&str) -> String,
) -> rusqlite::Result<Vec<String>> {
    let links: std::collections::BTreeSet<String> = notes_by_property(conn, "type", Some("link"))?
        .into_iter()
        .map(|m| m.path)
        .collect();
    Ok(notes_by_property(conn, "url", None)?
        .into_iter()
        .filter(|m| links.contains(&m.path))
        .filter(|m| m.value.as_str().is_some_and(|u| normalize(u) == wanted))
        .map(|m| m.path)
        .collect())
}

/// Every tag with the number of notes using it, most used first.
pub fn tags(conn: &Connection) -> rusqlite::Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT tag, COUNT(DISTINCT note_id) AS c FROM tags GROUP BY tag ORDER BY c DESC, tag",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagCount {
            tag: r.get(0)?,
            count: r.get::<_, i64>(1)? as usize,
        })
    })?;
    rows.collect()
}

/// Notes carrying every tag in `tags` (a tag also matches its nested tags, case-insensitive)
/// below the vault-relative prefix `path` (empty: everywhere), sorted by path.
pub fn notes_filtered(
    conn: &Connection,
    tags: &[String],
    path: &str,
) -> rusqlite::Result<Vec<NoteSummary>> {
    fn like(s: &str) -> String {
        s.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    }
    let mut sql = String::from("SELECT n.path, n.title, n.aliases FROM notes n WHERE 1 = 1");
    let mut args: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag
            .trim_start_matches('#')
            .trim_end_matches('/')
            .to_lowercase();
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM tags t WHERE t.note_id = n.id \
             AND (lower(t.tag) = ? OR lower(t.tag) LIKE ? ESCAPE '\\'))",
        );
        args.push(tag.clone());
        args.push(format!("{}/%", like(&tag)));
    }
    let prefix = path.trim_start_matches("./").trim_start_matches('/');
    if !prefix.is_empty() {
        sql.push_str(" AND n.path LIKE ? ESCAPE '\\'");
        args.push(format!("{}%", like(prefix)));
    }
    sql.push_str(" ORDER BY n.path");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
        let aliases: String = r.get(2)?;
        Ok(NoteSummary {
            path: r.get(0)?,
            title: r.get(1)?,
            aliases: serde_json::from_str(&aliases).unwrap_or_default(),
        })
    })?;
    rows.collect()
}
