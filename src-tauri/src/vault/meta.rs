//! Metadata of one note: links, embeds, tags, headings, block ids and frontmatter.
//! The second implementation of the Obsidian grammar next to the markdown-it plugins; both are
//! tested against `fixtures/vault/`. Code spans, fences and `%%comments%%` are skipped.

use serde::Serialize;
use serde_json::Value;

use super::resolve::{is_markdown_path, parse_target};

/// A `[[wikilink]]` or `![[embed]]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Link {
    /// Note part of the target; empty for a link to the same note (`[[#Heading]]`).
    pub target: String,
    pub heading: Option<String>,
    pub block: Option<String>,
    /// Text after `|` (for embeds also a size like `100x60`).
    pub alias: Option<String>,
    pub embed: bool,
    /// 1-based line in the whole note (frontmatter included). Not part of the shared fixtures.
    #[serde(skip)]
    pub line: usize,
}

/// A Markdown link `[text](Note.md#heading)` to a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarkdownLink {
    pub target: String,
    pub heading: Option<String>,
    /// 1-based line in the whole note (frontmatter included).
    #[serde(skip)]
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Heading {
    pub level: u8,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PropertyType {
    Text,
    Number,
    Checkbox,
    Date,
    List,
}

/// A frontmatter property; the value keeps its YAML type.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Property {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: PropertyType,
    pub value: Value,
}

/// Everything the index needs to know about one note.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    /// Wikilinks and embeds in document order.
    pub links: Vec<Link>,
    /// Markdown links to notes (`.md` targets, no URLs).
    pub markdown_links: Vec<MarkdownLink>,
    /// Frontmatter tags first, then inline tags; without `#`, no duplicates.
    pub tags: Vec<String>,
    pub headings: Vec<Heading>,
    /// Block ids (`^id` at the end of a line), without the `^`.
    pub blocks: Vec<String>,
    pub properties: Vec<Property>,
    pub aliases: Vec<String>,
    /// Codes of problems that did not stop the extraction: `invalid-frontmatter`.
    pub warnings: Vec<String>,
}

pub const WARNING_INVALID_FRONTMATTER: &str = "invalid-frontmatter";

/// Extracts the metadata of one note. Never fails: broken frontmatter becomes a warning.
pub fn extract(text: &str) -> NoteMeta {
    let mut meta = NoteMeta::default();
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let (body, first_line) = match split_frontmatter(text) {
        Some((yaml, body)) => {
            read_frontmatter(yaml, &mut meta);
            (body, text.len() - body.len())
        }
        None => (text, 0),
    };
    let first_line = text[..first_line].matches('\n').count() + 1;
    scan_body(body, first_line, &mut meta);
    meta
}

/// `(yaml, body)` when the note starts with a `---` fenced block that is closed by `---` or `...`.
pub(super) fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    let mut lines = text.split_inclusive('\n');
    let first = lines.next()?;
    if !is_fence(first) {
        return None;
    }
    let yaml_start = first.len();
    let mut pos = yaml_start;
    for line in lines {
        let bare = line.trim_end_matches(['\n', '\r']);
        if is_fence(line) || bare == "..." {
            return Some((&text[yaml_start..pos], &text[pos + line.len()..]));
        }
        pos += line.len();
    }
    None
}

fn is_fence(line: &str) -> bool {
    line.trim_end_matches(['\n', '\r'])
        .strip_prefix("---")
        .is_some_and(|rest| rest.chars().all(|c| c == ' ' || c == '\t'))
}

fn read_frontmatter(yaml: &str, meta: &mut NoteMeta) {
    let value: serde_yaml_ng::Value = match serde_yaml_ng::from_str(yaml) {
        Ok(v) => v,
        Err(_) => return warn(meta),
    };
    let map = match value {
        serde_yaml_ng::Value::Null => return,
        serde_yaml_ng::Value::Mapping(map) => map,
        _ => return warn(meta),
    };
    for (key, value) in map {
        let key = match key {
            serde_yaml_ng::Value::String(s) => s,
            other => scalar_text(&to_json(other)),
        };
        let value = to_json(value);
        let lower = key.to_lowercase();
        if lower == "tags" || lower == "tag" {
            for item in items(&value, |c| c == ',' || c.is_whitespace()) {
                push_unique(&mut meta.tags, item.trim_start_matches('#').to_string());
            }
        } else if lower == "aliases" || lower == "alias" {
            meta.aliases.extend(items(&value, |c| c == ','));
        }
        meta.properties.push(Property {
            kind: property_type(&value),
            key,
            value,
        });
    }
}

fn warn(meta: &mut NoteMeta) {
    meta.warnings.push(WARNING_INVALID_FRONTMATTER.to_string());
}

fn to_json(value: serde_yaml_ng::Value) -> Value {
    use serde_yaml_ng::Value as Y;
    match value {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(b),
        Y::Number(n) => n
            .as_i64()
            .map(Value::from)
            .or_else(|| n.as_u64().map(Value::from))
            .or_else(|| {
                n.as_f64()
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number)
            })
            .unwrap_or(Value::Null),
        Y::String(s) => Value::String(s),
        Y::Sequence(items) => Value::Array(items.into_iter().map(to_json).collect()),
        Y::Mapping(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| {
                    let key = match k {
                        Y::String(s) => s,
                        other => scalar_text(&to_json(other)),
                    };
                    (key, to_json(v))
                })
                .collect(),
        ),
        Y::Tagged(tagged) => to_json(tagged.value),
    }
}

fn scalar_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// The non-empty items of a list value, or of a string split at `separator`.
fn items(value: &Value, separator: impl Fn(char) -> bool) -> Vec<String> {
    let raw: Vec<String> = match value {
        Value::Array(list) => list.iter().map(scalar_text).collect(),
        Value::String(s) => s.split(separator).map(str::to_string).collect(),
        _ => Vec::new(),
    };
    raw.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn property_type(value: &Value) -> PropertyType {
    match value {
        Value::Bool(_) => PropertyType::Checkbox,
        Value::Number(_) => PropertyType::Number,
        Value::Array(_) => PropertyType::List,
        Value::String(s) if is_date(s.trim()) => PropertyType::Date,
        _ => PropertyType::Text,
    }
}

/// `YYYY-MM-DD`, optionally followed by `T` or a space and `hh:mm[:ss[.f]]` with a zone.
fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |from: usize, n: usize| {
        b.len() >= from + n && b[from..from + n].iter().all(u8::is_ascii_digit)
    };
    if !(digits(0, 4)
        && b.get(4) == Some(&b'-')
        && digits(5, 2)
        && b.get(7) == Some(&b'-')
        && digits(8, 2))
    {
        return false;
    }
    if b.len() == 10 {
        return true;
    }
    if !(matches!(b[10], b'T' | b' ') && digits(11, 2) && b.get(13) == Some(&b':') && digits(14, 2))
    {
        return false;
    }
    let mut rest = &s[16..];
    if rest.starts_with(':')
        && rest.len() >= 3
        && rest.as_bytes()[1..3].iter().all(u8::is_ascii_digit)
    {
        rest = &rest[3..];
        if let Some(fraction) = rest.strip_prefix('.') {
            let n = fraction.bytes().take_while(u8::is_ascii_digit).count();
            if n == 0 {
                return false;
            }
            rest = &fraction[n..];
        }
    }
    match rest.as_bytes() {
        [] | [b'Z'] => true,
        [b'+' | b'-', zone @ ..] => {
            let zone: Vec<u8> = zone.iter().copied().filter(|c| *c != b':').collect();
            zone.len() == 4 && zone.iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

fn push_unique(list: &mut Vec<String>, item: String) {
    if !item.is_empty() && !list.contains(&item) {
        list.push(item);
    }
}

// ---------------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------------

pub(super) struct Fence {
    marker: u8,
    len: usize,
}

fn scan_body(body: &str, first_line: usize, meta: &mut NoteMeta) {
    let mut fence: Option<Fence> = None;
    let mut in_comment = false;
    let mut inline_tags = Vec::new();

    for (offset, line) in body.lines().enumerate() {
        if let Some(open) = &fence {
            if closes_fence(line, open) {
                fence = None;
            }
            continue;
        }
        if !in_comment {
            if let Some(open) = opens_fence(line) {
                fence = Some(open);
                continue;
            }
        }
        let (text, plain) = mask(line, &mut in_comment);
        if let Some(heading) = heading(&text) {
            meta.headings.push(heading);
        }
        if let Some(id) = block_id(&text) {
            push_unique(&mut meta.blocks, id);
        }
        let (links, markdown_links) = (meta.links.len(), meta.markdown_links.len());
        let rest = scan_links(&plain, meta);
        let number = first_line + offset;
        meta.links[links..].iter_mut().for_each(|l| l.line = number);
        meta.markdown_links[markdown_links..]
            .iter_mut()
            .for_each(|l| l.line = number);
        scan_tags(&rest, &mut inline_tags);
    }
    for tag in inline_tags {
        push_unique(&mut meta.tags, tag);
    }
}

fn fence_start(line: &str) -> Option<(u8, usize, &str)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let marker = *trimmed.as_bytes().first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let len = trimmed.bytes().take_while(|b| *b == marker).count();
    (len >= 3).then(|| (marker, len, &trimmed[len..]))
}

pub(super) fn opens_fence(line: &str) -> Option<Fence> {
    let (marker, len, info) = fence_start(line)?;
    // An info string with a backtick makes it an inline code span instead of a fence.
    if marker == b'`' && info.contains('`') {
        return None;
    }
    Some(Fence { marker, len })
}

pub(super) fn closes_fence(line: &str, open: &Fence) -> bool {
    fence_start(line).is_some_and(|(marker, len, rest)| {
        marker == open.marker && len >= open.len && rest.trim().is_empty()
    })
}

/// One pass over a line. Returns the line without `%%comments%%` (`text`) and the same line
/// with code spans blanked as well (`plain`). `in_comment` carries a comment across lines.
fn mask(line: &str, in_comment: &mut bool) -> (String, String) {
    let mut text = String::with_capacity(line.len());
    let mut plain = String::with_capacity(line.len());
    let mut i = 0;
    while i < line.len() {
        let rest = &line[i..];
        if *in_comment {
            match rest.find("%%") {
                Some(end) => {
                    *in_comment = false;
                    i += end + 2;
                }
                None => break,
            }
        } else if rest.starts_with('`') {
            let n = rest.bytes().take_while(|b| *b == b'`').count();
            match find_backtick_run(&rest[n..], n) {
                Some(close) => {
                    let end = n + close + n;
                    text.push_str(&rest[..end]);
                    plain.push(' ');
                    i += end;
                }
                None => {
                    text.push_str(&rest[..n]);
                    plain.push_str(&rest[..n]);
                    i += n;
                }
            }
        } else if rest.starts_with("%%") {
            *in_comment = true;
            i += 2;
        } else {
            let c = rest.chars().next().unwrap_or(' ');
            text.push(c);
            plain.push(c);
            i += c.len_utf8();
        }
    }
    (text, plain)
}

/// Offset of the next run of exactly `n` backticks.
pub(super) fn find_backtick_run(s: &str, n: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
            if run == n {
                return Some(i);
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}

pub(super) fn heading(line: &str) -> Option<Heading> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let level = trimmed.bytes().take_while(|b| *b == b'#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let mut text = rest.trim();
    let without_closing = text.trim_end_matches('#');
    if without_closing.len() < text.len()
        && (without_closing.is_empty() || without_closing.ends_with([' ', '\t']))
    {
        text = without_closing.trim_end();
    }
    (!text.is_empty()).then(|| Heading {
        level: level as u8,
        text: text.to_string(),
    })
}

/// The `^id` that ends a line, when it stands alone or after whitespace.
fn block_id(line: &str) -> Option<String> {
    let last = line.trim_end().rsplit([' ', '\t']).next()?;
    let id = last.strip_prefix('^')?;
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .then(|| id.to_string())
}

/// Collects wikilinks, embeds and Markdown links of a line. Returns the line with the matched
/// links blanked, so their targets are not mistaken for tags.
fn scan_links(line: &str, meta: &mut NoteMeta) -> String {
    let bytes = line.as_bytes();
    let mut blank = vec![false; bytes.len()];
    let mut open_brackets: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'[' if bytes.get(i + 1) == Some(&b'[') => {
                if let Some((link, end)) = wikilink(line, i) {
                    let start = if link.embed { i - 1 } else { i };
                    blank[start..end].fill(true);
                    meta.links.push(link);
                    i = end;
                    continue;
                }
                open_brackets.push(i);
            }
            b'[' => open_brackets.push(i),
            b']' if bytes.get(i + 1) == Some(&b'(') => {
                if let Some(open) = open_brackets.pop() {
                    if let Some((dest, end)) = link_destination(line, i + 2) {
                        let image = open > 0 && bytes[open - 1] == b'!';
                        if !image {
                            if let Some(link) = markdown_link(&dest) {
                                meta.markdown_links.push(link);
                            }
                        }
                        blank[i + 1..end].fill(true);
                        i = end;
                        continue;
                    }
                }
            }
            b']' => {
                open_brackets.pop();
            }
            _ => {}
        }
        i += 1;
    }
    line.char_indices()
        .map(|(at, c)| if blank[at] { ' ' } else { c })
        .collect()
}

/// A wikilink starting at `start` (`[[`); `end` is the offset after `]]`.
fn wikilink(line: &str, start: usize) -> Option<(Link, usize)> {
    let end = line[start + 2..].find("]]")? + start + 2;
    let inner = &line[start + 2..end];
    if inner.trim().is_empty() || inner.contains('[') || inner.trim().eq_ignore_ascii_case("_toc_")
    {
        return None;
    }
    let (target, alias) = match inner.split_once('|') {
        Some((t, a)) => (t.trim(), Some(a.trim()).filter(|a| !a.is_empty())),
        None => (inner.trim(), None),
    };
    if target.is_empty() {
        return None;
    }
    let parsed = parse_target(target);
    let link = Link {
        target: parsed.note,
        heading: parsed.heading,
        block: parsed.block,
        alias: alias.map(str::to_string),
        embed: start > 0 && line.as_bytes()[start - 1] == b'!',
        line: 0,
    };
    Some((link, end + 2))
}

/// The destination of `(…)` after `](` at `from`, and the offset after the closing `)`.
fn link_destination(line: &str, from: usize) -> Option<(String, usize)> {
    let rest = &line[from..];
    let close = rest.find(')')?;
    let inside = rest[..close].trim_start();
    let dest = if let Some(angle) = inside.strip_prefix('<') {
        angle.split('>').next()?
    } else {
        inside.split_whitespace().next().unwrap_or("")
    };
    Some((dest.to_string(), from + close + 1))
}

fn markdown_link(dest: &str) -> Option<MarkdownLink> {
    if has_scheme(dest) {
        return None;
    }
    let (path, fragment) = match dest.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (dest, None),
    };
    let path = percent_decode(path);
    if !is_markdown_path(&path) {
        return None;
    }
    Some(MarkdownLink {
        target: path,
        heading: fragment.filter(|f| !f.is_empty()).map(str::to_string),
        line: 0,
    })
}

pub(super) fn has_scheme(dest: &str) -> bool {
    match dest.find(':') {
        Some(i) if i > 1 => {
            let mut chars = dest[..i].chars();
            chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        }
        _ => false,
    }
}

pub(super) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_tag_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || matches!(c, '_' | '-' | '/')
}

/// Obsidian `#tag`: nested with `/`, unicode letters, at least one non-digit. Mirrors `tag.plugin.ts`.
fn scan_tags(line: &str, out: &mut Vec<String>) {
    let mut previous: Option<char> = None;
    let mut chars = line.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        let starts = c == '#' && previous.is_none_or(|p| p.is_whitespace() || "([{\"'".contains(p));
        previous = Some(c);
        if !starts {
            continue;
        }
        let rest = &line[at + 1..];
        let len: usize = rest
            .chars()
            .take_while(|c| is_tag_char(*c))
            .map(char::len_utf8)
            .sum();
        let name = rest[..len].trim_end_matches(['-', '/']);
        let has_letter = name
            .chars()
            .any(|c| !c.is_numeric() && !matches!(c, '-' | '/' | '_'));
        if has_letter && name.split('/').all(|part| !part.is_empty()) {
            out.push(name.to_string());
            for _ in 0..name.chars().count() {
                chars.next();
            }
            previous = name.chars().last();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, path::Path};

    fn link(target: &str) -> Link {
        Link {
            target: target.into(),
            heading: None,
            block: None,
            alias: None,
            embed: false,
            line: 1,
        }
    }

    #[test]
    fn wikilinks_and_embeds_keep_target_heading_block_and_alias() {
        let meta =
            extract("[[A]] [[B|alias]] [[C#Head]] [[D#^id|x]] ![[E]] ![[f.png|100x60]] [[#Same]]");
        let got = &meta.links;
        assert_eq!(got[0], link("A"));
        assert_eq!(got[1].alias.as_deref(), Some("alias"));
        assert_eq!(got[2].heading.as_deref(), Some("Head"));
        assert_eq!(
            (got[3].block.as_deref(), got[3].alias.as_deref()),
            (Some("id"), Some("x"))
        );
        assert!(got[4].embed && got[4].target == "E");
        assert_eq!(got[5].alias.as_deref(), Some("100x60"));
        assert_eq!(
            (got[6].target.as_str(), got[6].heading.as_deref()),
            ("", Some("Same"))
        );
        assert_eq!(got.len(), 7);
    }

    #[test]
    fn code_spans_fences_and_comments_are_skipped() {
        let text = "`[[a]] #a` ``[[b]] ` #b`` [[c]]\n```\n[[d]] #d ^d\n```\n~~~js\n[[e]]\n~~~\n\
                    %% [[f]] #f %% [[g]]\n%%\n[[i]] #i\n%%\n[[j]]";
        let meta = extract(text);
        let targets: Vec<&str> = meta.links.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(targets, ["c", "g", "j"]);
        assert!(meta.tags.is_empty(), "{:?}", meta.tags);
        assert!(meta.blocks.is_empty());
    }

    #[test]
    fn markdown_links_to_notes_only() {
        let meta = extract(
            "[a](Note.md) [b](folder/Deep.md#Top) [c](https://x.org/a.md) [d](#same) [e](img.png) \
             ![f](Image.md) [g](Loop%20A.md) [h](<My Note.md>)",
        );
        let got: Vec<(&str, Option<&str>)> = meta
            .markdown_links
            .iter()
            .map(|l| (l.target.as_str(), l.heading.as_deref()))
            .collect();
        assert_eq!(
            got,
            [
                ("Note.md", None),
                ("folder/Deep.md", Some("Top")),
                ("Loop A.md", None),
                ("My Note.md", None)
            ]
        );
    }

    #[test]
    fn inline_tags_follow_obsidian_rules() {
        let meta = extract(
            "#todo, #project/nixe/v1 and #übersicht. #2026 `#code` a#b [[N#Head]] (#paren) #a/ #-",
        );
        assert_eq!(
            meta.tags,
            ["todo", "project/nixe/v1", "übersicht", "paren", "a"]
        );
    }

    #[test]
    fn headings_and_block_ids() {
        let meta = extract("# One\n## Two ##\n####### seven\n#nospace\n    # indented\n###\nText ^b-1\n^alone\nx ^not valid");
        let got: Vec<(u8, &str)> = meta
            .headings
            .iter()
            .map(|h| (h.level, h.text.as_str()))
            .collect();
        assert_eq!(got, [(1, "One"), (2, "Two")]);
        assert_eq!(meta.blocks, ["b-1", "alone"]);
        assert_eq!(meta.tags, ["nospace"]);
    }

    #[test]
    fn frontmatter_properties_keep_their_type() {
        let meta = extract(
            "---\ntitle: Hello\ncount: 42\nratio: 0.75\ndone: true\ncreated: 2026-11-15\nstamp: 2026-11-15T21:45:00\n\
             list:\n  - a\n  - 2\nempty:\ntags: [x, '#y/z']\naliases: One, Two\n---\n# Body #inline",
        );
        let types: Vec<(&str, PropertyType)> = meta
            .properties
            .iter()
            .map(|p| (p.key.as_str(), p.kind))
            .collect();
        use PropertyType::*;
        assert_eq!(
            types,
            [
                ("title", Text),
                ("count", Number),
                ("ratio", Number),
                ("done", Checkbox),
                ("created", Date),
                ("stamp", Date),
                ("list", List),
                ("empty", Text),
                ("tags", List),
                ("aliases", Text),
            ]
        );
        assert_eq!(meta.properties[1].value, json!(42));
        assert_eq!(meta.properties[2].value, json!(0.75));
        assert_eq!(meta.properties[6].value, json!(["a", 2]));
        assert_eq!(meta.properties[7].value, Value::Null);
        assert_eq!(meta.tags, ["x", "y/z", "inline"]);
        assert_eq!(meta.aliases, ["One", "Two"]);
        assert_eq!(meta.headings.len(), 1);
        assert!(meta.warnings.is_empty());
    }

    #[test]
    fn invalid_frontmatter_is_a_warning_not_an_error() {
        for text in [
            "---\ntitle: [unclosed\ntags: : :\n---\n# Body [[A]]",
            "---\n- just\n- a list\n---\n# Body [[A]]",
        ] {
            let meta = extract(text);
            assert_eq!(meta.warnings, [WARNING_INVALID_FRONTMATTER]);
            assert!(meta.properties.is_empty());
            assert_eq!(meta.links.len(), 1, "the body is still read");
        }
    }

    #[test]
    fn frontmatter_needs_a_closing_fence_at_the_top() {
        assert!(extract("---\ntitle: x\n").properties.is_empty());
        assert!(extract("text\n---\ntitle: x\n---\n").properties.is_empty());
        let crlf = extract("\u{feff}---\r\ntitle: x\r\n...\r\n#tag");
        assert_eq!(crlf.properties.len(), 1);
        assert_eq!(crlf.tags, ["tag"]);
    }

    #[test]
    fn date_detection() {
        for yes in [
            "2026-11-15",
            "2026-11-15T21:45",
            "2026-11-15 21:45:00",
            "2026-11-15T21:45:00.5Z",
            "2026-11-15T21:45:00+01:00",
        ] {
            assert!(is_date(yes), "{yes}");
        }
        for no in [
            "2026-11",
            "2026-11-15x",
            "2026-11-15T21",
            "15.11.2026",
            "2026-11-15T21:45:00+1",
        ] {
            assert!(!is_date(no), "{no}");
        }
    }

    // --- shared fixtures -------------------------------------------------------------------

    fn vault_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/vault")
    }

    /// Every note of `fixtures/vault/` must match `.meta/<path>.json`. The same files are
    /// checked by `src/app/core/markdown/meta-fixture.spec.ts` against the TypeScript parser.
    /// `NIXE_UPDATE_FIXTURES=1` rewrites them (review the diff).
    #[test]
    fn fixture_vault_matches_expected_metadata() {
        let root = vault_dir();
        let update = std::env::var_os("NIXE_UPDATE_FIXTURES").is_some();
        let notes: Vec<String> = super::super::list_vault_files(&root)
            .into_iter()
            .filter(|f| f.ends_with(".md") && !f.starts_with(".meta/"))
            .collect();
        assert!(notes.len() >= 10, "{notes:?}");
        for note in notes {
            let actual =
                serde_json::to_value(extract(&fs::read_to_string(root.join(&note)).unwrap()))
                    .unwrap();
            let expected_path = root.join(".meta").join(format!("{note}.json"));
            if update {
                fs::create_dir_all(expected_path.parent().unwrap()).unwrap();
                fs::write(
                    &expected_path,
                    serde_json::to_string_pretty(&actual).unwrap() + "\n",
                )
                .unwrap();
            }
            let expected: Value = serde_json::from_str(
                &fs::read_to_string(&expected_path)
                    .unwrap_or_else(|_| panic!("missing {expected_path:?}")),
            )
            .unwrap();
            assert_eq!(actual, expected, "{note}");
        }
    }

    #[test]
    fn a_5000_line_note_is_extracted_quickly() {
        let mut text = String::from("---\ntitle: Big\ntags: [big]\n---\n");
        for i in 0..5000 {
            text.push_str(&match i % 5 {
                0 => format!("## Heading {i}\n"),
                1 => format!("Text with [[Note {i}|alias]] and #tag{i} and `code [[x]]` ^b{i}\n"),
                2 => format!("A [link](folder/Note {i}.md#h) and ![[image{i}.png|100]] and %% comment [[c]] %%\n"),
                3 => "```\ncode [[no]] #no\n```\n".to_string(),
                _ => "Plain paragraph text without anything special in it at all.\n".to_string(),
            });
        }
        assert!(text.lines().count() >= 5000);
        let start = std::time::Instant::now();
        let meta = extract(&text);
        let elapsed = start.elapsed();
        assert_eq!(meta.links.len(), 2000);
        // The 20 ms budget holds for release builds; debug builds only guard against blow-ups.
        let budget = if cfg!(debug_assertions) { 500 } else { 20 };
        assert!(elapsed.as_millis() < budget, "took {elapsed:?}");
    }
}

#[cfg(test)]
mod line_tests {
    use super::*;

    #[test]
    fn links_know_their_line_in_the_whole_note() {
        let meta = extract(
            "---\ntags: [a]\n---\nintro\n\n```\n[[no]]\n```\nsee [[A]] and [x](B.md)\n[[C]]",
        );
        assert_eq!(
            meta.links.iter().map(|l| l.line).collect::<Vec<_>>(),
            [9, 10]
        );
        assert_eq!(meta.markdown_links[0].line, 9);
        assert_eq!(extract("[[A]]").links[0].line, 1);
    }
}
