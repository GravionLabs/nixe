//! Vault-wide full-text search: query translation to FTS5 and result snippets.

use rusqlite::{params_from_iter, types::Value as Sql, Connection};
use serde::Serialize;

/// Notes returned per search.
pub const MAX_HITS: usize = 50;
/// Snippets shown per note.
const MAX_SNIPPETS: usize = 3;
/// Characters kept around a match.
const CONTEXT_CHARS: usize = 60;

/// A user query split into its parts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Query {
    /// FTS5 `MATCH` expression; `None` when the query has no text terms.
    pub fts: Option<String>,
    /// Lower-cased words and phrases to highlight.
    pub terms: Vec<String>,
    /// `tag:` operands without `#`, lower-cased.
    pub tags: Vec<String>,
    /// `path:` operands: a vault-relative prefix.
    pub paths: Vec<String>,
    /// `root:` operands (#117): names of workspace roots, lower-cased. A search in one vault
    /// ignores them; a workspace search keeps only the notes of the named roots.
    pub roots: Vec<String>,
}

impl Query {
    pub fn is_empty(&self) -> bool {
        self.fts.is_none() && self.tags.is_empty() && self.paths.is_empty() && self.roots.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchSnippet {
    /// 1-based line of the match.
    pub line: usize,
    /// The line, shortened around the match, with matches wrapped in `\u{1}` … `\u{2}`.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    /// Modification time of the file in milliseconds since the Unix epoch (0 when unknown).
    pub modified: i64,
    /// Lines of the note that match; `snippets` shows the first few of them.
    pub matches: usize,
    pub snippets: Vec<SearchSnippet>,
    /// Name of the root the note is in; set by a workspace search only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Absolute path of that root; set by a workspace search only.
    #[serde(rename = "rootPath", skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
}

/// Translates `input`: bare words match as prefixes (so results appear while typing), `"quoted
/// text"` matches exactly as a phrase, `tag:#name`, `path:folder/` and `root:name` (a workspace
/// root; `root:"two words"`) narrow the result.
pub fn parse_query(input: &str) -> Query {
    let mut q = Query::default();
    let mut fts: Vec<String> = Vec::new();
    for (token, quoted) in tokenize(input) {
        if quoted {
            let words = token.split_whitespace().collect::<Vec<_>>().join(" ");
            if !words.is_empty() {
                fts.push(format!("\"{}\"", words.replace('"', "\"\"")));
                q.terms.push(words.to_lowercase());
            }
        } else if let Some(tag) = token.strip_prefix("tag:") {
            let tag = tag.trim_start_matches('#').trim_end_matches('/');
            if !tag.is_empty() {
                q.tags.push(tag.to_lowercase());
            }
        } else if let Some(root) = token.strip_prefix("root:") {
            let root = root.trim();
            if !root.is_empty() {
                q.roots.push(root.to_lowercase());
            }
        } else if let Some(path) = token.strip_prefix("path:") {
            let path = path.trim_start_matches("./").trim_start_matches('/');
            if !path.is_empty() {
                q.paths.push(path.to_string());
            }
        } else {
            let word = token.replace('"', "");
            if word.chars().any(char::is_alphanumeric) {
                fts.push(format!("\"{word}\"*"));
                q.terms.push(word.to_lowercase());
            }
        }
    }
    if !fts.is_empty() {
        q.fts = Some(fts.join(" "));
    }
    q
}

/// Splits on whitespace; a `"…"` group (also directly after an operator) is one token.
fn tokenize(input: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut chars = input.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else if c == '"' {
            chars.next();
            let mut s = String::new();
            for c in chars.by_ref() {
                if c == '"' {
                    break;
                }
                s.push(c);
            }
            out.push((s, true));
        } else {
            let mut s = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                chars.next();
                if c == '"' && s.ends_with(':') {
                    // `root:"two words"`: the quoted text belongs to the operator.
                    for c in chars.by_ref() {
                        if c == '"' {
                            break;
                        }
                        s.push(c);
                    }
                    break;
                }
                s.push(c);
            }
            out.push((s, false));
        }
    }
    out
}

/// A note that matches, before its snippets are cut.
struct Candidate {
    id: i64,
    path: String,
    title: String,
    modified: i64,
    /// FTS5 rank (lower is better); 0 without text terms.
    rank: f64,
}

/// Notes matching `query`, best first, with up to three matching lines each.
pub fn search(conn: &Connection, input: &str) -> rusqlite::Result<Vec<SearchHit>> {
    let q = parse_query(input);
    if q.is_empty() {
        return Ok(Vec::new());
    }
    candidates(conn, &q)?
        .into_iter()
        .map(|c| hit(conn, &q, c))
        .collect()
}

/// One folder of a workspace search.
pub struct SearchRoot<'a> {
    pub name: &'a str,
    pub path: &'a str,
    pub conn: &'a Connection,
}

/// Notes of all `roots` matching `input`, best first (the rank of the FTS index decides, ties go
/// by root order and path), at most `MAX_HITS`; each hit names its root. A `root:` operand keeps
/// only the roots it names. Snippets are cut for the winners only.
pub fn search_roots(roots: &[SearchRoot], input: &str) -> rusqlite::Result<Vec<SearchHit>> {
    let q = parse_query(input);
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut all: Vec<(usize, Candidate)> = Vec::new();
    for (i, root) in roots.iter().enumerate() {
        if !q.roots.is_empty() && !q.roots.iter().any(|n| root.name.eq_ignore_ascii_case(n)) {
            continue;
        }
        for c in candidates(root.conn, &q)? {
            all.push((i, c));
        }
    }
    all.sort_by(|(ia, a), (ib, b)| {
        a.rank
            .total_cmp(&b.rank)
            .then(ia.cmp(ib))
            .then_with(|| a.path.cmp(&b.path))
    });
    all.truncate(MAX_HITS);
    all.into_iter()
        .map(|(i, c)| {
            let root = &roots[i];
            let mut h = hit(root.conn, &q, c)?;
            h.root = Some(root.name.to_string());
            h.root_path = Some(root.path.to_string());
            Ok(h)
        })
        .collect()
}

fn candidates(conn: &Connection, q: &Query) -> rusqlite::Result<Vec<Candidate>> {
    // Operands that only name a root leave every note of the root.
    let rank = if q.fts.is_some() {
        "notes_fts.rank"
    } else {
        "0.0"
    };
    let mut sql = format!(
        "SELECT n.id, n.path, n.title, COALESCE(f.mtime_ns / 1000000, 0), {rank} FROM notes n \
         LEFT JOIN files f ON f.path = n.path"
    );
    let mut args: Vec<Sql> = Vec::new();
    let mut wheres: Vec<String> = Vec::new();
    if let Some(fts) = &q.fts {
        sql.push_str(" JOIN notes_fts ON notes_fts.rowid = n.id");
        wheres.push("notes_fts MATCH ?".into());
        args.push(fts.clone().into());
    }
    for tag in &q.tags {
        wheres.push(
            "EXISTS (SELECT 1 FROM tags t WHERE t.note_id = n.id \
             AND (lower(t.tag) = ? OR lower(t.tag) LIKE ? ESCAPE '\\'))"
                .into(),
        );
        args.push(tag.clone().into());
        args.push(format!("{}/%", escape_like(tag)).into());
    }
    for path in &q.paths {
        wheres.push("n.path LIKE ? ESCAPE '\\'".into());
        args.push(format!("{}%", escape_like(path)).into());
    }
    if wheres.is_empty() {
        wheres.push("1".into());
    }
    sql.push_str(" WHERE ");
    sql.push_str(&wheres.join(" AND "));
    sql.push_str(if q.fts.is_some() {
        " ORDER BY notes_fts.rank, n.path"
    } else {
        " ORDER BY n.path"
    });
    sql.push_str(&format!(" LIMIT {MAX_HITS}"));
    conn.prepare_cached(&sql)?
        .query_map(params_from_iter(args), |r| {
            Ok(Candidate {
                id: r.get(0)?,
                path: r.get(1)?,
                title: r.get(2)?,
                modified: r.get(3)?,
                rank: r.get(4)?,
            })
        })?
        .collect()
}

fn hit(conn: &Connection, q: &Query, c: Candidate) -> rusqlite::Result<SearchHit> {
    let (snippets, matches) = if q.terms.is_empty() {
        (Vec::new(), 0)
    } else {
        let body: String =
            conn.query_row("SELECT body FROM notes_fts WHERE rowid = ?1", [c.id], |r| {
                r.get(0)
            })?;
        snippets(&body, &q.terms)
    };
    Ok(SearchHit {
        path: c.path,
        title: c.title,
        modified: c.modified,
        matches,
        snippets,
        root: None,
        root_path: None,
    })
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// The first lines of `body` containing a term, each shortened around its first match.
fn snippets(body: &str, terms: &[String]) -> (Vec<SearchSnippet>, usize) {
    let mut out = Vec::new();
    let mut matches = 0;
    for (i, line) in body.lines().enumerate() {
        let chars: Vec<char> = line.chars().collect();
        let lower: Vec<char> = chars.iter().map(|c| fold(*c)).collect();
        let ranges = match_ranges(&lower, terms);
        if ranges.is_empty() {
            continue;
        }
        matches += 1;
        if out.len() == MAX_SNIPPETS {
            continue;
        }
        let start = ranges[0].0.saturating_sub(CONTEXT_CHARS);
        let end = (ranges[0].1 + CONTEXT_CHARS * 2).min(chars.len());
        let mut text = String::new();
        if start > 0 {
            text.push('…');
        }
        let mut pos = start;
        for (s, e) in ranges.iter().filter(|(s, _)| *s >= start && *s < end) {
            if *s < pos {
                continue;
            }
            let e = (*e).min(end);
            text.extend(&chars[pos..*s]);
            text.push('\u{1}');
            text.extend(&chars[*s..e]);
            text.push('\u{2}');
            pos = e;
        }
        text.extend(&chars[pos..end]);
        if end < chars.len() {
            text.push('…');
        }
        out.push(SearchSnippet {
            line: i + 1,
            text: text.trim().to_string(),
        });
    }
    (out, matches)
}

/// Single-char lower-casing, so char positions stay aligned with the original line.
fn fold(c: char) -> char {
    let mut l = c.to_lowercase();
    match (l.next(), l.next()) {
        (Some(x), None) => x,
        _ => c,
    }
}

/// Sorted, non-overlapping `[start, end)` char ranges where a term occurs. A word term also
/// matches as a prefix, like the FTS query does.
fn match_ranges(line: &[char], terms: &[String]) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for term in terms {
        let t: Vec<char> = term.chars().collect();
        if t.is_empty() || t.len() > line.len() {
            continue;
        }
        let mut i = 0;
        while i + t.len() <= line.len() {
            let word_start = i == 0 || !line[i - 1].is_alphanumeric();
            if word_start && line[i..i + t.len()] == t[..] {
                let mut end = i + t.len();
                while end < line.len() && line[end].is_alphanumeric() && !term.contains(' ') {
                    end += 1;
                }
                ranges.push((i, end));
                i = end;
            } else {
                i += 1;
            }
        }
    }
    ranges.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for r in ranges {
        match merged.last_mut() {
            Some(last) if r.0 < last.1 => last.1 = last.1.max(r.1),
            _ => merged.push(r),
        }
    }
    merged
}
