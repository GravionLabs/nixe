//! The link note of `docs/links.md`: the metadata of a page, its reader text as Markdown, and
//! the text of the note.

use crate::capture::{decode_entities, extract_title};

/// What the `<head>` of a page says about it. Empty values are `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Metadata {
    pub title: Option<String>,
    pub og_title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
    pub canonical: Option<String>,
}

fn collapse(text: &str) -> Option<String> {
    let t = decode_entities(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!t.is_empty()).then_some(t)
}

/// The attributes of the tag text between `<` and `>` (names lower-cased, values decoded).
pub(super) fn attributes(tag: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let chars: Vec<char> = tag.chars().collect();
    let mut i = 0;
    // Skip the tag name.
    while i < chars.len() && !chars[i].is_whitespace() {
        i += 1;
    }
    while i < chars.len() {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == '/') {
            i += 1;
        }
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() && !matches!(chars[i], '=' | '/') {
            i += 1;
        }
        let name: String = chars[start..i].iter().collect::<String>().to_lowercase();
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < chars.len() && chars[i] == '=' {
            i += 1;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            if i < chars.len() && matches!(chars[i], '"' | '\'') {
                let quote = chars[i];
                i += 1;
                while i < chars.len() && chars[i] != quote {
                    value.push(chars[i]);
                    i += 1;
                }
                i += 1;
            } else {
                while i < chars.len() && !chars[i].is_whitespace() {
                    value.push(chars[i]);
                    i += 1;
                }
            }
        }
        if !name.is_empty() {
            out.push((name, decode_entities(&value)));
        }
    }
    out
}

/// The text of the `<head>` (or of the start of a page that has none).
fn head_of(html: &str) -> &str {
    let lower = html.to_ascii_lowercase();
    let end = lower
        .find("</head")
        .or_else(|| lower.find("<body"))
        .unwrap_or_else(|| html.len().min(64 * 1024));
    let mut end = end.min(html.len());
    while !html.is_char_boundary(end) {
        end -= 1;
    }
    &html[..end]
}

/// The metadata of the page; the first value of a key wins.
pub fn extract_metadata(html: &str) -> Metadata {
    let head = head_of(html);
    let lower = head.to_ascii_lowercase();
    let mut meta = Metadata {
        title: extract_title(head),
        ..Metadata::default()
    };
    let mut meta_description = None;
    let mut at = 0;
    while let Some(found) = lower[at..].find('<') {
        let start = at + found + 1;
        let Some(len) = lower[start..].find('>') else {
            break;
        };
        let tag = &head[start..start + len];
        at = start + len;
        let name = tag
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if name != "meta" && name != "link" {
            continue;
        }
        let attrs = attributes(tag);
        let get = |key: &str| {
            attrs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        if name == "link" {
            let is_canonical = get("rel").is_some_and(|r| {
                r.split_whitespace()
                    .any(|w| w.eq_ignore_ascii_case("canonical"))
            });
            if is_canonical && meta.canonical.is_none() {
                meta.canonical = get("href").and_then(collapse);
            }
            continue;
        }
        let key = get("property")
            .or_else(|| get("name"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let Some(value) = get("content").and_then(collapse) else {
            continue;
        };
        let slot = match key.as_str() {
            "og:title" => &mut meta.og_title,
            "og:description" => &mut meta.description,
            "description" => &mut meta_description,
            "og:image" => &mut meta.image,
            "og:site_name" => &mut meta.site_name,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(value);
        }
    }
    meta.description = meta.description.or(meta_description);
    meta
}

/// The reader text of the page as Markdown; `Err` says why there is none.
pub fn reader_markdown(html: &str, url: &str) -> Result<String, String> {
    let mut readability = dom_smoothie::Readability::new(html, Some(url), None)
        .map_err(|e| format!("the page cannot be read: {e}"))?;
    let article = readability
        .parse()
        .map_err(|e| format!("the page has no readable content: {e}"))?;
    let markdown = htmd::convert(&article.content)
        .map_err(|e| format!("the page cannot be converted to Markdown: {e}"))?;
    let markdown = markdown.trim();
    if markdown.is_empty() {
        return Err("the page has no readable content".into());
    }
    Ok(markdown.to_string())
}

/// The value as a YAML scalar on one line.
fn yaml(value: &str) -> String {
    let one_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    serde_yaml_ng::to_string(&one_line)
        .map(|s| s.trim_end().to_string())
        .unwrap_or_else(|_| format!("{one_line:?}"))
}

/// Everything a link note holds.
pub struct Note<'a> {
    pub url: &'a str,
    pub title: &'a str,
    pub tags: &'a [String],
    pub saved: &'a str,
    /// `unread` or `read`.
    pub status: &'a str,
    pub description: Option<&'a str>,
    pub image: Option<&'a str>,
    pub site: Option<&'a str>,
    /// Archive files next to the note, relative to its folder (`.archive/<stem>.html`).
    pub archive_files: &'a [String],
    /// The reader text; `None` leaves out `## Archive`.
    pub archive: Option<&'a str>,
}

/// The text of the note in the order of `docs/links.md`.
pub fn render(note: &Note) -> String {
    let mut out = String::from("---\ntype: link\n");
    out.push_str(&format!("url: {}\n", yaml(note.url)));
    out.push_str(&format!("title: {}\n", yaml(note.title)));
    if note.tags.is_empty() {
        out.push_str("tags: []\n");
    } else {
        out.push_str("tags:\n");
        for tag in note.tags {
            out.push_str(&format!("  - {}\n", yaml(tag)));
        }
    }
    out.push_str(&format!(
        "saved: {}\nstatus: {}\n",
        yaml(note.saved),
        note.status
    ));
    for (key, value) in [
        ("description", note.description),
        ("image", note.image),
        ("site", note.site),
    ] {
        if let Some(v) = value.filter(|v| !v.trim().is_empty()) {
            out.push_str(&format!("{key}: {}\n", yaml(v)));
        }
    }
    if !note.archive_files.is_empty() {
        out.push_str("archive:\n");
        for file in note.archive_files {
            out.push_str(&format!("  - {}\n", yaml(file)));
        }
    }
    out.push_str("---\n\n");
    if let Some(d) = note.description.filter(|d| !d.trim().is_empty()) {
        let one_line = d.split_whitespace().collect::<Vec<_>>().join(" ");
        out.push_str(&format!("> {one_line}\n\n"));
    }
    out.push_str("## Notes\n");
    if let Some(archive) = note.archive {
        out.push_str(&format!("\n## Archive\n\n{archive}\n"));
    }
    out
}

/// The file name (with `.md`) for a title: the characters that `cli_write::note_file_name`
/// refuses become `-`, a title that is empty afterwards falls back to `fallback` (the host).
pub fn file_name(title: &str, fallback: &str) -> String {
    let clean = |text: &str| -> String {
        let replaced: String = text
            .chars()
            .map(|c| {
                if c.is_control() || "\\/:*?\"<>|#^[]".contains(c) {
                    '-'
                } else {
                    c
                }
            })
            .collect();
        let joined = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
        let trimmed = joined.trim_matches(|c: char| c == '.' || c.is_whitespace());
        let trimmed = trimmed
            .strip_suffix(".md")
            .filter(|s| !s.is_empty())
            .unwrap_or(trimmed);
        trimmed
            .chars()
            .take(120)
            .collect::<String>()
            .trim_end()
            .to_string()
    };
    let stem = Some(clean(title))
        .filter(|s| !s.is_empty())
        .or_else(|| Some(clean(fallback)).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "link".into());
    format!("{stem}.md")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_metadata_of_the_head() {
        let m = extract_metadata(
            "<html><head><title> A &amp; B </title>\
             <meta property='og:title' content='Open Title'>\
             <meta name=description content='plain'>\
             <meta property=\"og:image\" content=\"https://x.test/i.png\">\
             <meta property=\"og:site_name\" content=\"X\">\
             <link rel=\"Canonical\" href=\"https://x.test/a\">\
             </head><body><meta name='description' content='late'></body></html>",
        );
        assert_eq!(m.title.as_deref(), Some("A & B"));
        assert_eq!(m.og_title.as_deref(), Some("Open Title"));
        assert_eq!(m.description.as_deref(), Some("plain"));
        assert_eq!(m.image.as_deref(), Some("https://x.test/i.png"));
        assert_eq!(m.site_name.as_deref(), Some("X"));
        assert_eq!(m.canonical.as_deref(), Some("https://x.test/a"));
        assert_eq!(extract_metadata("<p>text</p>"), Metadata::default());
    }

    #[test]
    fn og_description_beats_the_meta_description() {
        let m = extract_metadata(
            "<head><meta name=description content=b><meta property=og:description content=a></head>",
        );
        assert_eq!(m.description.as_deref(), Some("a"));
    }

    #[test]
    fn renders_the_note_in_the_documented_order() {
        let tags = vec!["reading".to_string()];
        let text = render(&Note {
            url: "https://x.test/a",
            title: "Title: with colon",
            tags: &tags,
            saved: "2026-11-20T09:30:00+01:00",
            status: "unread",
            description: Some("About it"),
            image: None,
            site: Some("x.test"),
            archive_files: &[".archive/T.html".to_string()],
            archive: Some("# Body"),
        });
        assert_eq!(
            text,
            "---\ntype: link\nurl: https://x.test/a\ntitle: 'Title: with colon'\ntags:\n  - reading\n\
             saved: 2026-11-20T09:30:00+01:00\nstatus: unread\ndescription: About it\nsite: x.test\narchive:\n  - .archive/T.html\n---\n\n\
             > About it\n\n## Notes\n\n## Archive\n\n# Body\n"
        );
        let bare = render(&Note {
            url: "https://x.test/",
            title: "T",
            tags: &[],
            saved: "s",
            status: "unread",
            description: None,
            image: None,
            site: None,
            archive_files: &[],
            archive: None,
        });
        assert!(bare.contains("tags: []\n"));
        assert!(bare.ends_with("## Notes\n"));
    }

    #[test]
    fn file_names_are_safe() {
        assert_eq!(file_name("a/b: c?", "h"), "a-b- c-.md");
        assert_eq!(file_name("Idea.md", "h"), "Idea.md");
        assert_eq!(file_name("  ..  ", "example.org"), "example.org.md");
        assert_eq!(file_name("", ""), "link.md");
        assert!(file_name(&"x".repeat(500), "h").len() <= 123);
    }
}
