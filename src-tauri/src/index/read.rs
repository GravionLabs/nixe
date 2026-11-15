//! Read side of the index: what the commands return.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoteSummary {
    pub path: String,
    pub title: String,
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
    let mut stmt = conn.prepare("SELECT path, title FROM notes ORDER BY path")?;
    let rows = stmt.query_map([], |r| {
        Ok(NoteSummary {
            path: r.get(0)?,
            title: r.get(1)?,
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
