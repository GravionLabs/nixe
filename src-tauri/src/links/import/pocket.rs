//! Pocket exports: the CSV (`title,url,time_added,cursor,tags,status`) and the older HTML
//! (`<h1>Unread</h1>` / `<h1>Read Archive</h1>` above lists of `<a time_added tags>`).

use super::{attr, saved_from_epoch, split_tags, tokens, Entry, Token};

pub fn parse_html(html: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut read = false;
    let mut it = tokens(html).into_iter();
    while let Some(token) = it.next() {
        let Token::Tag {
            name,
            closing: false,
            attrs,
        } = token
        else {
            continue;
        };
        if name != "h1" && name != "a" {
            continue;
        }
        let mut text = String::new();
        for t in it.by_ref() {
            match t {
                Token::Text(t) => text.push_str(&t),
                Token::Tag {
                    name: n,
                    closing: true,
                    ..
                } if n == name => break,
                Token::Tag { .. } => {}
            }
        }
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if name == "h1" {
            let heading = text.to_lowercase();
            read = heading.contains("archive") || heading == "read";
        } else if let Some(url) = attr(&attrs, "href") {
            entries.push(Entry {
                url: url.trim().to_string(),
                title: (!text.is_empty()).then_some(text),
                tags: attr(&attrs, "tags").map(split_tags).unwrap_or_default(),
                saved: attr(&attrs, "time_added").and_then(saved_from_epoch),
                read,
                folders: Vec::new(),
                description: None,
                note: None,
            });
        }
    }
    entries
}

/// The CSV records of `text`: quoted fields may hold commas, doubled quotes and line breaks.
pub(super) fn records(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        match (c, quoted) {
            ('"', true) if chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            ('"', true) => quoted = false,
            ('"', false) if field.is_empty() => quoted = true,
            (',', false) => row.push(std::mem::take(&mut field)),
            ('\r', false) => {}
            ('\n', false) => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            (c, _) => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows.retain(|r| r.iter().any(|f| !f.trim().is_empty()));
    rows
}

pub fn parse_csv(text: &str) -> Result<Vec<Entry>, String> {
    let rows = records(text);
    let Some((header, rows)) = rows.split_first() else {
        return Ok(Vec::new());
    };
    let column = |name: &str| {
        header
            .iter()
            .position(|h| h.trim().eq_ignore_ascii_case(name))
    };
    let url = column("url").ok_or("the CSV has no `url` column")?;
    let (title, added, tags, status) = (
        column("title"),
        column("time_added"),
        column("tags"),
        column("status"),
    );
    let get = |row: &[String], i: Option<usize>| {
        i.and_then(|i| row.get(i))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(Entry {
                url: get(row, Some(url))?,
                title: get(row, title),
                tags: get(row, tags)
                    .map(|t| split_tags(t.replace('|', ",")))
                    .unwrap_or_default(),
                saved: get(row, added).and_then(saved_from_epoch),
                read: get(row, status).is_some_and(|s| s.eq_ignore_ascii_case("archive")),
                folders: Vec::new(),
                description: None,
                note: None,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../fixtures/import")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn csv_has_tags_time_and_status() {
        let entries = parse_csv(&fixture("pocket.csv")).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].title.as_deref(), Some("Pocket \"quoted\" title"));
        assert_eq!(entries[0].tags, ["rust", "web"]);
        assert_eq!(
            entries[0].saved.as_deref(),
            Some("2023-11-14T22:13:20+00:00")
        );
        assert!(!entries[0].read);
        assert_eq!(entries[1].title.as_deref(), Some("Comma, in the title"));
        assert!(entries[1].read);
        assert!(entries[1].tags.is_empty());
        assert_eq!(entries[2].title, None);
        assert_eq!(entries[2].tags, ["a", "b"]);
    }

    #[test]
    fn csv_without_a_url_column_is_an_error() {
        assert!(parse_csv("title,tags\nx,y\n").is_err());
    }

    #[test]
    fn html_has_tags_time_and_status_from_the_heading() {
        let entries = parse_html(&fixture("pocket.html"));
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].url, "https://example.com/old-one");
        assert_eq!(entries[0].tags, ["rust", "web"]);
        assert_eq!(
            entries[0].saved.as_deref(),
            Some("2023-11-14T22:13:20+00:00")
        );
        assert!(!entries[0].read);
        assert!(entries[1].read);
        assert!(entries[1].tags.is_empty());
    }
}
