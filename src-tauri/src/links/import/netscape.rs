//! Netscape bookmark HTML, the export of Chrome, Firefox, Edge and Safari: `<H3>` folders that
//! hold a `<DL>` list of `<A HREF ADD_DATE TAGS>` bookmarks.

use super::{attr, saved_from_epoch, split_tags, tokens, Entry, Token};

pub fn parse(html: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    // One element per open `<DL>`: the folder it belongs to (`None` for the root list).
    let mut lists: Vec<Option<String>> = Vec::new();
    let mut pending: Option<String> = None;
    let mut it = tokens(html).into_iter().peekable();
    while let Some(token) = it.next() {
        let Token::Tag {
            name,
            closing,
            attrs,
        } = token
        else {
            continue;
        };
        match (name.as_str(), closing) {
            ("h3", false) => pending = Some(text_until(&mut it, "h3")),
            ("dl", false) => lists.push(pending.take()),
            ("dl", true) => {
                lists.pop();
            }
            ("a", false) => {
                let title = text_until(&mut it, "a");
                let Some(url) = attr(&attrs, "href") else {
                    continue;
                };
                entries.push(Entry {
                    url: url.trim().to_string(),
                    title: (!title.is_empty()).then_some(title),
                    tags: attr(&attrs, "tags").map(split_tags).unwrap_or_default(),
                    saved: attr(&attrs, "add_date").and_then(saved_from_epoch),
                    read: false,
                    folders: lists.iter().flatten().cloned().collect(),
                });
            }
            _ => {}
        }
    }
    entries
}

/// The text up to the closing tag `name`, with whitespace collapsed.
fn text_until(it: &mut impl Iterator<Item = Token>, name: &str) -> String {
    let mut text = String::new();
    for token in it {
        match token {
            Token::Text(t) => text.push_str(&t),
            Token::Tag {
                name: n,
                closing: true,
                ..
            } if n == name => break,
            Token::Tag { .. } => {}
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../fixtures/import/bookmarks.html"),
        )
        .unwrap()
    }

    #[test]
    fn folders_dates_and_tags() {
        let entries = parse(&fixture());
        assert_eq!(entries.len(), 5);
        let first = &entries[0];
        assert_eq!(first.url, "https://example.com/rust?utm_source=x");
        assert_eq!(first.title.as_deref(), Some("The Rust & Co Book"));
        assert_eq!(first.tags, ["rust", "programming"]);
        assert_eq!(first.saved.as_deref(), Some("2023-11-14T22:13:20+00:00"));
        assert_eq!(first.folders, ["Bookmarks bar"]);
        assert!(!first.read);
        assert_eq!(entries[1].folders, ["Bookmarks bar", "Reading"]);
        // After the closing list the folder is left again.
        assert_eq!(entries[2].url, "javascript:alert(1)");
        assert_eq!(entries[2].folders, ["Bookmarks bar"]);
        assert!(entries[3].folders.is_empty());
        assert_eq!(entries[3].tags, Vec::<String>::new());
    }
}
