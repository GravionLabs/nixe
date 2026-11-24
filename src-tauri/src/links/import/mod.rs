//! `nixe import-links <file>`: link notes from a browser bookmark export (Netscape HTML) or a
//! Pocket export (CSV or the older HTML). See `docs/links.md`.

pub mod netscape;
pub mod pocket;

use std::path::Path;

use chrono::{DateTime, FixedOffset};

use super::fetch::Fetcher;
use super::note;
use super::{clip_with, ClipError, ClipRequest, DEFAULT_FOLDER};
use crate::capture::decode_entities;
use crate::vault::config::Config;

/// One bookmark of an export.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Entry {
    pub url: String,
    pub title: Option<String>,
    pub tags: Vec<String>,
    /// RFC 3339, from the date the export names.
    pub saved: Option<String>,
    pub read: bool,
    /// The bookmark folders around it, outermost first.
    pub folders: Vec<String>,
}

/// What an import did. `failed` and `warnings` hold one line each.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    pub created: usize,
    /// Already in the vault, or not an `http(s)` address.
    pub skipped: usize,
    pub failed: Vec<String>,
    pub warnings: Vec<String>,
}

/// The entries of an export; the format comes from the content: a CSV with a header line, or
/// HTML in the Netscape form (folders) or the Pocket form.
pub fn parse(text: &str) -> Result<Vec<Entry>, String> {
    let head = text.trim_start_matches('\u{feff}').trim_start();
    if !head.starts_with('<') {
        return pocket::parse_csv(text);
    }
    let lower = text.to_lowercase();
    if lower.contains("netscape-bookmark-file") || lower.contains("<dt>") {
        Ok(netscape::parse(text))
    } else if lower.contains("<a ") {
        Ok(pocket::parse_html(text))
    } else {
        Err("not a bookmark or Pocket export".into())
    }
}

/// Saves every entry as a link note. Without `fetch` nothing is downloaded: the title comes from
/// the export. With it each page goes through `clip`; a page that cannot be fetched is saved
/// from the export and reported in `warnings`. `folder` (vault-relative) replaces the links
/// folder; bookmark folders become subfolders of it.
pub fn import(
    root: &Path,
    app_data: &Path,
    entries: &[Entry],
    folder: Option<&str>,
    fetch: bool,
    now: &DateTime<FixedOffset>,
    fetcher: Fetcher,
) -> Summary {
    let base = folder
        .map(str::to_string)
        .or_else(|| Config::load(root).links_folder())
        .unwrap_or_else(|| DEFAULT_FOLDER.to_string());
    let mut summary = Summary::default();
    for entry in entries {
        let dir = std::iter::once(base.trim_matches('/').to_string())
            .chain(entry.folders.iter().filter_map(|f| segment(f)))
            .collect::<Vec<_>>()
            .join("/");
        let request = |offline: bool| ClipRequest {
            url: entry.url.clone(),
            html: None,
            title: if offline || !fetch {
                entry.title.clone()
            } else {
                None
            },
            tags: entry.tags.clone(),
            folder: Some(dir.clone()),
            saved: entry.saved.clone(),
            status: entry.read.then(|| "read".to_string()),
            offline,
        };
        let mut result = clip_with(root, app_data, request(!fetch), now, fetcher);
        if fetch {
            if let Err(ClipError::Fetch(why)) = &result {
                summary
                    .warnings
                    .push(format!("{}: {why}; saved from the export", entry.url));
                result = clip_with(root, app_data, request(true), now, fetcher);
            }
        }
        match result {
            Ok(r) => {
                if r.created {
                    summary.created += 1;
                } else {
                    summary.skipped += 1;
                }
                summary.warnings.extend(r.warnings);
            }
            // Not a web address (`javascript:`, `place:`, `file:`): nothing to save.
            Err(ClipError::Url(_)) => summary.skipped += 1,
            Err(e) => summary.failed.push(format!("{}: {e}", entry.url)),
        }
    }
    summary
}

/// A bookmark folder name as one path segment; `None` when nothing is left of it.
fn segment(name: &str) -> Option<String> {
    let file = note::file_name(name, "");
    let stem = file.strip_suffix(".md").unwrap_or(&file).trim();
    (!stem.is_empty()).then(|| stem.to_string())
}

pub(super) enum Token {
    Tag {
        /// Lower-case.
        name: String,
        closing: bool,
        attrs: Vec<(String, String)>,
    },
    /// Entities decoded.
    Text(String),
}

/// A tolerant tokenizer: comments and declarations are dropped, `>` inside a quoted attribute
/// value does not end a tag, `<script>` and `<style>` bodies are skipped.
pub(super) fn tokens(html: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut rest = html;
    while !rest.is_empty() {
        let Some(open) = rest.find('<') else {
            out.push(Token::Text(decode_entities(rest)));
            break;
        };
        if open > 0 {
            out.push(Token::Text(decode_entities(&rest[..open])));
        }
        rest = &rest[open..];
        if let Some(after) = rest.strip_prefix("<!--") {
            rest = after.find("-->").map_or("", |i| &after[i + 3..]);
            continue;
        }
        let mut quote = None;
        let mut end = None;
        for (i, c) in rest.char_indices().skip(1) {
            match (quote, c) {
                (None, '"' | '\'') => quote = Some(c),
                (Some(q), c) if c == q => quote = None,
                (None, '>') => {
                    end = Some(i);
                    break;
                }
                _ => {}
            }
        }
        let Some(end) = end else {
            break;
        };
        let inner = &rest[1..end];
        rest = &rest[end + 1..];
        if inner.starts_with('!') || inner.starts_with('?') {
            continue;
        }
        let (closing, inner) = match inner.strip_prefix('/') {
            Some(i) => (true, i),
            None => (false, inner),
        };
        let name: String = inner
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != '/')
            .collect::<String>()
            .to_lowercase();
        if name.is_empty() {
            continue;
        }
        if !closing && (name == "script" || name == "style") {
            let close = format!("</{name}");
            let lower = rest.to_lowercase();
            rest = lower.find(&close).map_or("", |i| &rest[i..]);
            continue;
        }
        out.push(Token::Tag {
            attrs: if closing {
                Vec::new()
            } else {
                note::attributes(inner)
            },
            name,
            closing,
        });
    }
    out
}

pub(super) fn attr(attrs: &[(String, String)], name: &str) -> Option<String> {
    attrs
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// A comma separated tag list as the note keeps it; `clip` drops a leading `#` and duplicates.
pub(super) fn split_tags(list: impl AsRef<str>) -> Vec<String> {
    list.as_ref()
        .split(',')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Seconds since the epoch (an export writes them) as an RFC 3339 time in UTC.
pub(super) fn saved_from_epoch(seconds: String) -> Option<String> {
    let seconds: i64 = seconds.trim().parse().ok()?;
    // Some exports write milliseconds.
    let seconds = if seconds > 100_000_000_000 {
        seconds / 1000
    } else {
        seconds
    };
    DateTime::from_timestamp(seconds, 0).map(|t| t.format("%Y-%m-%dT%H:%M:%S+00:00").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::links::fetch::Page;
    use chrono::TimeZone;
    use std::path::PathBuf;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../fixtures/import")
                .join(name),
        )
        .unwrap()
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-import-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    fn now() -> DateTime<FixedOffset> {
        FixedOffset::east_opt(0)
            .unwrap()
            .with_ymd_and_hms(2026, 11, 24, 8, 0, 0)
            .unwrap()
    }

    fn no_network(url: &str) -> Result<Page, ClipError> {
        panic!("fetched {url}")
    }

    #[test]
    fn the_format_is_found_from_the_content() {
        assert_eq!(parse(&fixture("bookmarks.html")).unwrap().len(), 5);
        assert_eq!(parse(&fixture("pocket.csv")).unwrap().len(), 3);
        assert_eq!(parse(&fixture("pocket.html")).unwrap().len(), 2);
        assert!(parse("<html><body>nothing</body></html>").is_err());
    }

    #[test]
    fn bookmarks_become_notes_in_collection_folders_without_a_fetch() {
        let root = tmp("netscape");
        let data = root.with_extension("data");
        let entries = parse(&fixture("bookmarks.html")).unwrap();
        let s = import(&root, &data, &entries, None, false, &now(), &no_network);
        // The bookmarklet and the duplicate of the first are skipped.
        assert_eq!((s.created, s.skipped), (3, 2), "{s:?}");
        assert!(s.failed.is_empty(), "{s:?}");
        let first = std::fs::read_to_string(root.join("Links/Bookmarks bar/The Rust & Co Book.md"))
            .unwrap();
        assert!(
            first.starts_with(
                "---\ntype: link\nurl: https://example.com/rust\ntitle: The Rust & Co Book\n\
             tags:\n  - rust\n  - programming\nsaved: 2023-11-14T22:13:20+00:00\nstatus: unread\n"
            ),
            "{first}"
        );
        assert!(!first.contains("## Archive"));
        assert!(root
            .join("Links/Bookmarks bar/Reading/Deep link.md")
            .exists());
        assert!(root.join("Links/Top level.md").exists());
    }

    #[test]
    fn a_second_import_creates_nothing() {
        let root = tmp("twice");
        let data = root.with_extension("data");
        let entries = parse(&fixture("pocket.csv")).unwrap();
        let first = import(&root, &data, &entries, None, false, &now(), &no_network);
        assert_eq!(first.created, 3);
        let again = import(&root, &data, &entries, None, false, &now(), &no_network);
        assert_eq!((again.created, again.skipped), (0, 3));
    }

    #[test]
    fn pocket_status_becomes_read_and_the_folder_option_is_the_base() {
        let root = tmp("pocket");
        let data = root.with_extension("data");
        let entries = parse(&fixture("pocket.html")).unwrap();
        let s = import(
            &root,
            &data,
            &entries,
            Some("Reading/Pocket"),
            false,
            &now(),
            &no_network,
        );
        assert_eq!(s.created, 2);
        let read = std::fs::read_to_string(root.join("Reading/Pocket/Old two.md")).unwrap();
        assert!(read.contains("status: read\n"), "{read}");
        let unread = std::fs::read_to_string(root.join("Reading/Pocket/Old one.md")).unwrap();
        assert!(unread.contains("status: unread\n"));
    }

    #[test]
    fn fetch_clips_each_page_and_falls_back_to_the_export() {
        let root = tmp("fetch");
        let data = root.with_extension("data");
        let entries = parse(&fixture("pocket.html")).unwrap();
        let page = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/web/article.html"),
        )
        .unwrap();
        let fetcher = move |url: &str| {
            if url.ends_with("old-one") {
                Ok(Page {
                    bytes: page.clone(),
                    content_type: Some("text/html".into()),
                })
            } else {
                Err(ClipError::Fetch(format!("{url}: 404")))
            }
        };
        let s = import(&root, &data, &entries, None, true, &now(), &fetcher);
        assert_eq!((s.created, s.skipped), (2, 0), "{s:?}");
        assert_eq!(s.warnings.len(), 1, "{s:?}");
        let fetched =
            std::fs::read_to_string(root.join("Links/Keeping notes as plain files.md")).unwrap();
        assert!(fetched.contains("## Archive"));
        assert!(fetched.contains("  - rust\n"));
        let fallback = std::fs::read_to_string(root.join("Links/Old two.md")).unwrap();
        assert!(fallback.contains("status: read\n"));
        assert!(!fallback.contains("## Archive"));
    }

    #[test]
    fn epoch_seconds_and_milliseconds() {
        assert_eq!(
            saved_from_epoch("1700000000".into()).as_deref(),
            Some("2023-11-14T22:13:20+00:00")
        );
        assert_eq!(
            saved_from_epoch("1700000000000".into()).as_deref(),
            Some("2023-11-14T22:13:20+00:00")
        );
        assert_eq!(saved_from_epoch("x".into()), None);
    }
}
