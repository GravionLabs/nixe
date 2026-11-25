//! The Raindrop.io CSV export: `id,title,note,excerpt,url,folder,tags,created,…`. The collection
//! (`folder`) becomes a subfolder, `excerpt` the description and `note` the text under `## Notes`.

use super::pocket::records;
use super::{saved_from_iso, split_tags, Entry};

/// Whether `header` (the first CSV record) is the one of a Raindrop export.
pub fn is_header(header: &[String]) -> bool {
    let has = |name: &str| header.iter().any(|h| h.trim().eq_ignore_ascii_case(name));
    has("url") && has("folder") && has("created")
}

pub fn parse(text: &str) -> Result<Vec<Entry>, String> {
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
    let get = |row: &[String], i: Option<usize>| {
        i.and_then(|i| row.get(i))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let (title, note, excerpt, folder, tags, created) = (
        column("title"),
        column("note"),
        column("excerpt"),
        column("folder"),
        column("tags"),
        column("created"),
    );
    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(Entry {
                url: get(row, Some(url))?,
                title: get(row, title),
                tags: get(row, tags).map(split_tags).unwrap_or_default(),
                saved: get(row, created).and_then(|c| saved_from_iso(&c)),
                read: false,
                folders: get(row, folder).into_iter().collect(),
                description: get(row, excerpt),
                note: get(row, note),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../fixtures/import/raindrop.csv"),
        )
        .unwrap()
    }

    #[test]
    fn collection_tags_created_excerpt_and_note() {
        let entries = parse(&fixture()).unwrap();
        assert_eq!(entries.len(), 3);
        let first = &entries[0];
        assert_eq!(first.url, "https://example.com/rust-book");
        assert_eq!(first.title.as_deref(), Some("The \"Rust\" Book"));
        assert_eq!(first.folders, ["Programming"]);
        assert_eq!(first.tags, ["rust", "books"]);
        assert_eq!(first.saved.as_deref(), Some("2023-11-14T22:13:20+00:00"));
        assert_eq!(first.description.as_deref(), Some("An intro to Rust"));
        assert_eq!(
            first.note.as_deref(),
            Some("Chapter 4, read twice\nsecond line")
        );
        assert_eq!(entries[1].title, None);
        assert_eq!(entries[1].note, None);
        assert_eq!(
            entries[1].saved.as_deref(),
            Some("2023-11-15T10:00:00+00:00")
        );
    }

    #[test]
    fn the_header_decides() {
        let h = |s: &str| s.split(',').map(str::to_string).collect::<Vec<_>>();
        assert!(is_header(&h(
            "id,title,note,excerpt,url,folder,tags,created"
        )));
        assert!(!is_header(&h("title,url,time_added,tags,status")));
    }

    #[test]
    fn a_csv_without_a_url_column_is_an_error() {
        assert!(parse("title,folder\nx,y\n").is_err());
    }
}
