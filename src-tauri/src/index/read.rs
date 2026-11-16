//! Read side of the index: what the commands return.

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
