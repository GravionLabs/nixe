//! The note composer (#113), like Obsidian's: extract a selection or a section into a new or an
//! existing note, and merge a note into another one.
//!
//! The planning is pure (file list and note texts in, the new texts out), so the confirmation can
//! show every note that changes before anything is written. Applying reads nothing again: all
//! texts were read while planning, and the writes follow in one burst, so the vault watcher
//! reports one debounced batch.
//!
//! Links that follow the text:
//! - Extract: `[[Source#Heading]]` and `[[Source#^block]]` for a heading or block id that moved
//!   now name the target (also `[[#Heading]]` inside the source). In the moved text `[[#Other]]`
//!   names the source, and Markdown links with a path relative to the note are recomputed.
//! - Merge: every link to the merged note names the target (the rewrite of `relink`), with heading
//!   and block kept; the merged note goes to `.trash/`. Its frontmatter is not appended.
//!
//! Not rewritten: Markdown links with a `#heading` fragment, links in the frontmatter, in code and
//! in `%%comments%%`.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::meta::{self, closes_fence, opens_fence, split_frontmatter};
use super::relink::{
    link_format, link_text, plan, relative_to, relocate_links, rewrite_lines, Edit, LinkFormat,
    Move,
};
use super::resolve::{is_markdown_path, Resolver};
use crate::write;

/// What happens to a note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// A new note receives the extracted text.
    Create,
    /// The text goes to the end of an existing note.
    Append,
    /// Text or links change.
    Update,
    /// The note moves to `.trash/`.
    Trash,
}

/// A note the operation changes, as shown in the confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    /// Vault-relative, forward slashes.
    pub path: String,
    pub action: Action,
    /// Number of links rewritten in the note.
    pub links: usize,
}

/// What to extract from the source note.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum What {
    /// A selection: UTF-16 offsets (those of the editor) and the text the editor selected, which
    /// guards against a note that changed meanwhile.
    Selection {
        start: usize,
        end: usize,
        expected: String,
    },
    /// The heading on this 1-based line with everything below it up to the next heading of the
    /// same or a higher level.
    Heading { line: usize },
}

/// The result of planning: the texts to write, in order (the first must succeed for the rest to
/// run), the note to trash and what the confirmation lists.
#[derive(Debug, Default)]
pub struct Plan {
    pub writes: Vec<(String, String)>,
    pub trash: Option<String>,
    pub changes: Vec<Change>,
}

// ---------------------------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------------------------

/// Byte range of the UTF-16 range `start..end` of `text`; `None` when it is empty, outside the
/// text or splits a character.
fn utf16_range(text: &str, start: usize, end: usize) -> Option<(usize, usize)> {
    if start >= end {
        return None;
    }
    let (mut from, mut to) = (None, None);
    let mut units = 0;
    for (i, c) in text.char_indices() {
        if units == start {
            from = Some(i);
        }
        if units == end {
            to = Some(i);
            break;
        }
        units += c.len_utf16();
        if units > start && from.is_none() {
            return None;
        }
        if units > end && to.is_none() {
            return None;
        }
    }
    if units == start {
        from = Some(text.len());
    }
    if units == end && to.is_none() {
        to = Some(text.len());
    }
    Some((from?, to?))
}

/// Byte range of the section of the heading on `line` (1-based).
fn section_range(text: &str, line: usize) -> Option<(usize, usize)> {
    let plain = text.strip_prefix('\u{feff}').unwrap_or(text);
    let bom = text.len() - plain.len();
    let body_start = bom + split_frontmatter(plain).map_or(0, |(_, body)| plain.len() - body.len());
    // (1-based line, byte offset, level)
    let mut headings: Vec<(usize, usize, u8)> = Vec::new();
    let mut fence = None;
    let mut offset = 0;
    for (n, raw) in text.split_inclusive('\n').enumerate() {
        let start = offset;
        offset += raw.len();
        if start < body_start {
            continue;
        }
        let bare = raw.trim_end_matches(['\n', '\r']);
        if let Some(open) = &fence {
            if closes_fence(bare, open) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = opens_fence(bare) {
            fence = Some(open);
            continue;
        }
        if let Some(h) = meta::heading(bare) {
            headings.push((n + 1, start, h.level));
        }
    }
    let at = headings.iter().position(|h| h.0 == line)?;
    let (_, start, level) = headings[at];
    let end = headings[at + 1..]
        .iter()
        .find(|h| h.2 <= level)
        .map_or(text.len(), |h| h.1);
    Some((start, end))
}

// ---------------------------------------------------------------------------------------------
// Link retargeting
// ---------------------------------------------------------------------------------------------

/// How a heading or block id is compared: headings by their words without case, blocks by id.
fn anchor_key(anchor: &str) -> String {
    match anchor.trim().strip_prefix('^') {
        Some(id) => format!("^{}", id.trim()),
        None => anchor
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase(),
    }
}

/// The headings and block ids of `text`, as `anchor_key`s.
fn anchors_of(text: &str) -> HashSet<String> {
    let meta = meta::extract(text);
    meta.headings
        .iter()
        .map(|h| anchor_key(&h.text))
        .chain(meta.blocks.iter().map(|b| format!("^{b}")))
        .collect()
}

/// The edits of the note part in the `[[Note#anchor]]` links of a line. `rule` gets the trimmed
/// note part (empty for `[[#anchor]]`) and the key of the anchor and returns the new note part.
fn anchor_edits(
    line: &str,
    masked: &str,
    rule: &dyn Fn(&str, &str) -> Option<String>,
) -> Vec<Edit> {
    let mut edits = Vec::new();
    let mut i = 0;
    while let Some(open) = masked[i..].find("[[").map(|p| p + i) {
        let Some(end) = masked[open + 2..].find("]]").map(|p| p + open + 2) else {
            break;
        };
        let inner = &masked[open + 2..end];
        if inner.contains('[') {
            i = open + 1;
            continue;
        }
        i = end + 2;
        let head = &line[open + 2..open + 2 + inner.find('|').unwrap_or(inner.len())];
        let Some(hash) = head.find('#') else { continue };
        let note = &head[..hash];
        let anchor = head[hash + 1..].split('#').next().unwrap_or("");
        if let Some(text) = rule(note.trim(), &anchor_key(anchor)) {
            if text != note {
                edits.push(Edit {
                    start: open + 2,
                    end: open + 2 + hash,
                    text,
                });
            }
        }
    }
    edits
}

/// What an extraction needs to know to retarget links.
struct Moved<'a> {
    files_after: &'a [String],
    format: LinkFormat,
    source: &'a str,
    target: &'a str,
    anchors: &'a HashSet<String>,
    old: Resolver,
}

impl Moved<'_> {
    fn name_of(&self, note: &str, from: &str) -> String {
        link_text(self.files_after, self.format, note, from, true)
    }

    /// In a note that stays (the source without the extracted text, or any other note): links to
    /// an anchor that moved name the target.
    fn remaining(&self, text: &str, here: &str) -> (String, usize) {
        if self.anchors.is_empty() {
            return (text.to_string(), 0);
        }
        let name = self.name_of(self.target, here);
        rewrite_lines(text, |line, masked| {
            anchor_edits(line, masked, &|note, key| {
                if !self.anchors.contains(key) {
                    return None;
                }
                let names_source = if note.is_empty() {
                    here == self.source
                } else {
                    self.old.resolve(note).as_deref() == Some(self.source)
                };
                names_source.then(|| name.clone())
            })
        })
    }

    /// In the extracted text, now in the target: links to anchors that stayed name the source.
    fn moved(&self, text: &str) -> (String, usize) {
        let to_source = self.name_of(self.source, self.target);
        let to_target = self.name_of(self.target, self.target);
        rewrite_lines(text, |line, masked| {
            anchor_edits(line, masked, &|note, key| {
                if note.is_empty() {
                    return (!self.anchors.contains(key)).then(|| to_source.clone());
                }
                (self.anchors.contains(key)
                    && self.old.resolve(note).as_deref() == Some(self.source))
                .then(|| to_target.clone())
            })
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------------------------

fn line_ending(text: &str) -> &str {
    if text.ends_with("\r\n") {
        "\r\n"
    } else if text.ends_with('\n') {
        "\n"
    } else {
        ""
    }
}

fn check_target(source: &str, target: &str, files: &[String]) -> Result<(), String> {
    if !target.to_lowercase().ends_with(".md") {
        return Err(format!("not a note: {target}"));
    }
    if target == source {
        return Err("the target is the note itself".into());
    }
    if target
        .split('/')
        .any(|p| p.is_empty() || p == "." || p == "..")
        || target.starts_with(".trash/")
        || target.starts_with(".obsidian/")
        || target.starts_with(".git/")
    {
        return Err(format!("not a path of the vault: {target}"));
    }
    if files
        .iter()
        .any(|f| f != target && f.eq_ignore_ascii_case(target))
    {
        return Err(format!(
            "a note with another capitalization exists: {target}"
        ));
    }
    Ok(())
}

/// Plans the extraction of `what` from `source` into `target` (new when `target_text` is
/// `None`). `files` is the vault, `read` returns the text of a note, `candidates` the notes
/// that may link to the source.
#[allow(clippy::too_many_arguments)]
pub fn plan_extract(
    files: &[String],
    format: LinkFormat,
    source: &str,
    what: &What,
    target: &str,
    embed: bool,
    candidates: &[String],
    read: impl Fn(&str) -> Option<String>,
) -> Result<Plan, String> {
    check_target(source, target, files)?;
    let raw = read(source).ok_or_else(|| format!("cannot read {source}"))?;
    // The editor counts offsets in text with `\n` line ends and without a BOM; so do we, and
    // the source gets its own line ends and BOM back when it is written.
    let bom = raw.starts_with('\u{feff}');
    let crlf = raw.contains("\r\n");
    let source_text = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let target_text = if files.iter().any(|f| f == target) {
        Some(read(target).ok_or_else(|| format!("cannot read {target}"))?)
    } else {
        None
    };
    let (start, end) = match what {
        What::Selection {
            start,
            end,
            expected,
        } => {
            let range = utf16_range(&source_text, *start, *end)
                .ok_or_else(|| "the selection is empty or outside the note".to_string())?;
            if source_text[range.0..range.1] != *expected {
                return Err("the note changed since the selection was made".into());
            }
            range
        }
        What::Heading { line } => section_range(&source_text, *line)
            .ok_or_else(|| format!("no heading on line {line}"))?,
    };
    let moved_raw = &source_text[start..end];
    if moved_raw.trim().is_empty() {
        return Err("nothing to extract".into());
    }
    let mut files_after = files.to_vec();
    if target_text.is_none() {
        files_after.push(target.to_string());
    }
    let anchors = anchors_of(moved_raw);
    let ctx = Moved {
        files_after: &files_after,
        format,
        source,
        target,
        anchors: &anchors,
        old: Resolver::new(files),
    };

    // The source: a link or an embed where the text was.
    let name = ctx.name_of(target, source);
    let marker = if embed { "!" } else { "" };
    let left = format!(
        "{}{marker}[[{name}]]{}",
        &source_text[..start],
        line_ending(moved_raw)
    );
    let (source_new, source_links) =
        ctx.remaining(&format!("{left}{}", &source_text[end..]), source);

    // The moved text, as it reads in the target.
    let relocated = relocate_links(moved_raw, source, target, files, format);
    let (moved_text, moved_links) = ctx.moved(&relocated);
    let moved_text = moved_text.trim_start_matches(['\n', '\r']).trim_end();

    let mut plan = Plan::default();
    let mut target_links = moved_links;
    let target_content = match target_text {
        None => format!("{moved_text}\n"),
        Some(existing) => {
            let (existing, links) = ctx.remaining(&existing, target);
            target_links += links;
            let head = existing.trim_end();
            if head.is_empty() {
                format!("{moved_text}\n")
            } else {
                format!("{head}\n\n{moved_text}\n")
            }
        }
    };
    let new_target = files.iter().all(|f| f != target);
    plan.changes.push(Change {
        path: target.to_string(),
        action: if new_target {
            Action::Create
        } else {
            Action::Append
        },
        links: target_links,
    });
    plan.writes.push((target.to_string(), target_content));
    plan.changes.push(Change {
        path: source.to_string(),
        action: Action::Update,
        links: source_links,
    });
    let source_new = if crlf {
        source_new.replace('\n', "\r\n")
    } else {
        source_new
    };
    let source_new = if bom {
        format!("\u{feff}{source_new}")
    } else {
        source_new
    };
    plan.writes.push((source.to_string(), source_new));

    let mut others: Vec<&String> = candidates
        .iter()
        .filter(|p| is_markdown_path(p) && *p != source && *p != target && files.contains(p))
        .collect();
    others.sort_unstable();
    others.dedup();
    for path in others {
        let Some(text) = read(path) else { continue };
        let (content, links) = ctx.remaining(&text, path);
        if links > 0 {
            plan.changes.push(Change {
                path: path.clone(),
                action: Action::Update,
                links,
            });
            plan.writes.push((path.clone(), content));
        }
    }
    Ok(plan)
}

// ---------------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------------

/// Plans appending `source` to `target` (both existing notes), the rewrite of the links to
/// `source` and its move to `.trash/`.
pub fn plan_merge(
    files: &[String],
    format: LinkFormat,
    source: &str,
    target: &str,
    candidates: &[String],
    read: impl Fn(&str) -> Option<String>,
) -> Result<Plan, String> {
    if source == target {
        return Err("the target is the note itself".into());
    }
    for path in [source, target] {
        if !is_markdown_path(path) || !files.iter().any(|f| f == path) {
            return Err(format!("not a note of the vault: {path}"));
        }
    }
    let mut candidates = candidates.to_vec();
    candidates.push(target.to_string());
    let moves = [Move {
        from: source.to_string(),
        to: target.to_string(),
    }];
    let rewrites = plan(files, &moves, format, &candidates, &read);
    let text_of = |path: &str| -> Result<(String, usize), String> {
        match rewrites.iter().find(|r| r.from == path) {
            Some(r) => Ok((r.content.clone(), r.links)),
            None => read(path)
                .map(|t| (t, 0))
                .ok_or_else(|| format!("cannot read {path}")),
        }
    };
    let (source_text, source_links) = text_of(source)?;
    let (target_text, target_links) = text_of(target)?;
    let source_text = source_text.strip_prefix('\u{feff}').unwrap_or(&source_text);
    let body = split_frontmatter(source_text).map_or(source_text, |(_, body)| body);
    let body = body.trim_matches(['\n', '\r']);
    let head = target_text.trim_end();
    let merged = match (head.is_empty(), body.is_empty()) {
        (_, true) => target_text.clone(),
        (true, false) => format!("{body}\n"),
        (false, false) => format!("{head}\n\n{body}\n"),
    };

    let mut result = Plan::default();
    result.changes.push(Change {
        path: target.to_string(),
        action: Action::Append,
        links: target_links + source_links,
    });
    result.writes.push((target.to_string(), merged));
    for r in &rewrites {
        if r.from == source || r.from == target {
            continue;
        }
        result.changes.push(Change {
            path: r.to.clone(),
            action: Action::Update,
            links: r.links,
        });
        result.writes.push((r.to.clone(), r.content.clone()));
    }
    result.changes.push(Change {
        path: source.to_string(),
        action: Action::Trash,
        links: 0,
    });
    result.trash = Some(source.to_string());
    Ok(result)
}

// ---------------------------------------------------------------------------------------------
// On disk
// ---------------------------------------------------------------------------------------------

fn read_note(root: &Path, path: &str) -> Option<String> {
    String::from_utf8(fs::read(root.join(path)).ok()?).ok()
}

fn rel(root: &Path, path: &str) -> Result<String, String> {
    relative_to(root, Path::new(path)).ok_or_else(|| format!("not a path of the vault: {path}"))
}

fn candidates(
    files: &[String],
    source: &str,
    referrers: impl Fn(&[String]) -> Option<Vec<String>>,
) -> Vec<String> {
    referrers(&[source.to_string()]).unwrap_or_else(|| files.to_vec())
}

/// What `extract` would change; writes nothing.
pub fn preview_extract(
    root: &Path,
    source: &str,
    what: &What,
    target: &str,
    embed: bool,
    referrers: impl Fn(&[String]) -> Option<Vec<String>>,
) -> Result<Vec<Change>, String> {
    Ok(plan_extract_on_disk(root, source, what, target, embed, referrers)?.changes)
}

fn plan_extract_on_disk(
    root: &Path,
    source: &str,
    what: &What,
    target: &str,
    embed: bool,
    referrers: impl Fn(&[String]) -> Option<Vec<String>>,
) -> Result<Plan, String> {
    let (source, target) = (rel(root, source)?, rel(root, target)?);
    let files = super::list_vault_files(root);
    let found = candidates(&files, &source, referrers);
    plan_extract(
        &files,
        link_format(root),
        &source,
        what,
        &target,
        embed,
        &found,
        |p| read_note(root, p),
    )
}

/// Moves the text into the target note and leaves a link or an embed. Returns the notes changed.
pub fn extract(
    root: &Path,
    source: &str,
    what: &What,
    target: &str,
    embed: bool,
    referrers: impl Fn(&[String]) -> Option<Vec<String>>,
) -> Result<Vec<Change>, String> {
    let plan = plan_extract_on_disk(root, source, what, target, embed, referrers)?;
    apply(root, plan)
}

/// What `merge` would change; writes nothing.
pub fn preview_merge(
    root: &Path,
    source: &str,
    target: &str,
    referrers: impl Fn(&[String]) -> Option<Vec<String>>,
) -> Result<Vec<Change>, String> {
    Ok(plan_merge_on_disk(root, source, target, referrers)?.changes)
}

fn plan_merge_on_disk(
    root: &Path,
    source: &str,
    target: &str,
    referrers: impl Fn(&[String]) -> Option<Vec<String>>,
) -> Result<Plan, String> {
    let (source, target) = (rel(root, source)?, rel(root, target)?);
    let files = super::list_vault_files(root);
    let found = candidates(&files, &source, referrers);
    plan_merge(&files, link_format(root), &source, &target, &found, |p| {
        read_note(root, p)
    })
}

/// Appends `source` to `target`, rewrites the links to it and moves it to `.trash/`.
pub fn merge(
    root: &Path,
    source: &str,
    target: &str,
    referrers: impl Fn(&[String]) -> Option<Vec<String>>,
) -> Result<Vec<Change>, String> {
    let plan = plan_merge_on_disk(root, source, target, referrers)?;
    apply(root, plan)
}

/// Writes the planned texts in one burst, the target first: when that fails nothing else is
/// touched. A later failure is reported after the rest was done, so no text is lost.
fn apply(root: &Path, plan: Plan) -> Result<Vec<Change>, String> {
    let mut failed = Vec::new();
    for (i, (path, content)) in plan.writes.iter().enumerate() {
        let abs = root.join(path);
        let result = match abs.parent() {
            Some(dir) if !dir.exists() => crate::fileops::create_dir(root, dir),
            _ => Ok(()),
        }
        .and_then(|()| write::write_text_file(root, &abs, content));
        if let Err(e) = result {
            if i == 0 {
                return Err(e);
            }
            failed.push(e);
        }
    }
    // The text is in the target now, so a failed link rewrite does not hold back the trash.
    if let Some(source) = &plan.trash {
        if let Err(e) = crate::fileops::trash_path(root, &root.join(source)) {
            failed.push(e);
        }
    }
    if failed.is_empty() {
        Ok(plan.changes)
    } else {
        Err(format!(
            "done, but not everything could be updated: {}",
            failed.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;
    use std::collections::HashMap;

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn sel(text: &str, part: &str) -> What {
        let at = text.find(part).unwrap();
        let start = text[..at].encode_utf16().count();
        What::Selection {
            start,
            end: start + part.encode_utf16().count(),
            expected: part.to_string(),
        }
    }

    fn texts(list: &[(&str, &str)]) -> HashMap<String, String> {
        list.iter()
            .map(|(p, t)| (p.to_string(), t.to_string()))
            .collect()
    }

    fn content<'a>(plan: &'a Plan, path: &str) -> &'a str {
        &plan.writes.iter().find(|w| w.0 == path).unwrap().1
    }

    fn extract_plan(
        vault: &[(&str, &str)],
        source: &str,
        what: &What,
        target: &str,
        embed: bool,
    ) -> Result<Plan, String> {
        let t = texts(vault);
        let names: Vec<String> = vault.iter().map(|(p, _)| p.to_string()).collect();
        plan_extract(
            &names,
            LinkFormat::Shortest,
            source,
            what,
            target,
            embed,
            &names,
            |p| t.get(p).cloned(),
        )
    }

    fn merge_plan(
        vault: &[(&str, &str)],
        source: &str,
        target: &str,
        format: LinkFormat,
    ) -> Result<Plan, String> {
        let t = texts(vault);
        let names: Vec<String> = vault.iter().map(|(p, _)| p.to_string()).collect();
        plan_merge(&names, format, source, target, &names, |p| {
            t.get(p).cloned()
        })
    }

    #[test]
    fn utf16_offsets_become_byte_offsets() {
        let text = "a😀b𝄞c";
        // 😀 and 𝄞 are two UTF-16 units each.
        assert_eq!(utf16_range(text, 1, 3), Some((1, 5)));
        assert_eq!(utf16_range(text, 3, 4), Some((5, 6)));
        assert_eq!(utf16_range(text, 4, 7), Some((6, 11)));
        assert_eq!(utf16_range(text, 0, 7), Some((0, text.len())));
        assert_eq!(utf16_range(text, 2, 3), None, "splits a character");
        assert_eq!(utf16_range(text, 3, 3), None);
        assert_eq!(utf16_range(text, 3, 99), None);
    }

    #[test]
    fn a_section_ends_at_the_next_heading_of_its_level_or_higher() {
        let text =
            "---\ntitle: x\n---\n# A\nintro\n## B\nbody\n```\n# not a heading\n```\n### C\ndeep\n## D\nend\n";
        let (s, e) = section_range(text, 6).unwrap();
        assert_eq!(
            &text[s..e],
            "## B\nbody\n```\n# not a heading\n```\n### C\ndeep\n"
        );
        let (s, e) = section_range(text, 4).unwrap();
        assert_eq!(s, text.find("# A").unwrap());
        assert_eq!(e, text.len());
        assert!(section_range(text, 5).is_none());
        assert!(section_range(text, 9).is_none());
    }

    #[test]
    fn extracting_a_selection_into_a_new_note_leaves_a_link() {
        let source = "# Plan\nKeep this. Move this part. Keep that.\n";
        let plan = extract_plan(
            &[("Plan.md", source), ("Other.md", "[[Plan]]")],
            "Plan.md",
            &sel(source, "Move this part."),
            "Parts/Part.md",
            false,
        )
        .unwrap();
        assert_eq!(content(&plan, "Parts/Part.md"), "Move this part.\n");
        assert_eq!(
            content(&plan, "Plan.md"),
            "# Plan\nKeep this. [[Part]] Keep that.\n"
        );
        assert_eq!(plan.changes[0].action, Action::Create);
        assert_eq!(plan.changes[1].action, Action::Update);
        assert_eq!(plan.changes.len(), 2, "plain links to the source stay");
    }

    #[test]
    fn the_embed_setting_leaves_an_embed() {
        let source = "one\ntwo\nthree\n";
        let plan = extract_plan(
            &[("a.md", source)],
            "a.md",
            &sel(source, "two\n"),
            "two.md",
            true,
        )
        .unwrap();
        assert_eq!(content(&plan, "a.md"), "one\n![[two]]\nthree\n");
        assert_eq!(content(&plan, "two.md"), "two\n");
    }

    #[test]
    fn extracting_into_an_existing_note_appends() {
        let source = "x\nmove\n";
        let plan = extract_plan(
            &[("a.md", source), ("b.md", "# B\nold\n\n\n")],
            "a.md",
            &sel(source, "move"),
            "b.md",
            false,
        )
        .unwrap();
        assert_eq!(content(&plan, "b.md"), "# B\nold\n\nmove\n");
        assert_eq!(plan.changes[0].action, Action::Append);
        assert_eq!(content(&plan, "a.md"), "x\n[[b]]\n");
    }

    #[test]
    fn extracting_a_heading_retargets_links_to_it() {
        let source = "# Top\nintro\n## Idea\nbody ^blk\n### Detail\nmore\n## Next\nend\n";
        let other = "see [[Source#Idea]] and [[Source#idea|alias]] and ![[Source#^blk]] \
                     and [[Source#Next]] and [[Source#Detail]] and [[Source]] and `[[Source#Idea]]`\n";
        let plan = extract_plan(
            &[("Source.md", source), ("Other.md", other)],
            "Source.md",
            &What::Heading { line: 3 },
            "Idea.md",
            false,
        )
        .unwrap();
        assert_eq!(
            content(&plan, "Idea.md"),
            "## Idea\nbody ^blk\n### Detail\nmore\n"
        );
        assert_eq!(
            content(&plan, "Source.md"),
            "# Top\nintro\n[[Idea]]\n## Next\nend\n"
        );
        assert_eq!(
            content(&plan, "Other.md"),
            "see [[Idea#Idea]] and [[Idea#idea|alias]] and ![[Idea#^blk]] \
             and [[Source#Next]] and [[Idea#Detail]] and [[Source]] and `[[Source#Idea]]`\n"
        );
        let other_change = plan.changes.iter().find(|c| c.path == "Other.md").unwrap();
        assert_eq!(other_change.links, 4);
    }

    #[test]
    fn same_note_links_follow_the_text_in_both_directions() {
        let source = "# Top\nsee [[#Idea]] and [[#Top]]\n## Idea\nback to [[#Top]] and [[#Idea]] and [[#Idea#^x]]\n";
        let plan = extract_plan(
            &[("Source.md", source)],
            "Source.md",
            &What::Heading { line: 3 },
            "Idea.md",
            false,
        )
        .unwrap();
        // Staying: a link into the moved section names the target.
        assert_eq!(
            content(&plan, "Source.md"),
            "# Top\nsee [[Idea#Idea]] and [[#Top]]\n[[Idea]]\n"
        );
        // Moving: a link to what stayed names the source; a link inside the moved text stays.
        assert_eq!(
            content(&plan, "Idea.md"),
            "## Idea\nback to [[Source#Top]] and [[#Idea]] and [[#Idea#^x]]\n"
        );
    }

    #[test]
    fn relative_markdown_links_are_recomputed_for_the_target() {
        let source = "text [img](pic.png) and [n](Other.md)\n";
        let plan = {
            let names = files(&["d/Source.md", "d/pic.png", "d/Other.md", "Root.md"]);
            plan_extract(
                &names,
                LinkFormat::Relative,
                "d/Source.md",
                &sel(source, "[img](pic.png)"),
                "e/New.md",
                false,
                &[],
                |p| (p == "d/Source.md").then(|| source.to_string()),
            )
            .unwrap()
        };
        assert_eq!(content(&plan, "e/New.md"), "[img](../d/pic.png)\n");
    }

    #[test]
    fn crlf_and_bom_notes_keep_their_form() {
        // The editor sees "a\nb\nc" (no BOM, `\n` line ends).
        let source = "\u{feff}a\r\nb\r\nc";
        let what = What::Selection {
            start: 4,
            end: 5,
            expected: "c".into(),
        };
        let plan = extract_plan(&[("a.md", source)], "a.md", &what, "n.md", false).unwrap();
        assert_eq!(content(&plan, "a.md"), "\u{feff}a\r\nb\r\n[[n]]");
        assert_eq!(content(&plan, "n.md"), "c\n");
        let across = What::Selection {
            start: 1,
            end: 4,
            expected: "\nb\n".into(),
        };
        assert!(extract_plan(&[("a.md", source)], "a.md", &across, "n.md", false).is_ok());
    }

    #[test]
    fn extract_refuses_bad_input() {
        let v = [("a.md", "abc\n"), ("b.md", "")];
        let ok = sel("abc\n", "abc");
        assert!(extract_plan(&v, "a.md", &ok, "a.md", false).is_err());
        assert!(extract_plan(&v, "a.md", &ok, "x.txt", false).is_err());
        assert!(extract_plan(&v, "a.md", &ok, "../x.md", false).is_err());
        assert!(extract_plan(&v, "a.md", &ok, ".trash/x.md", false).is_err());
        assert!(extract_plan(&v, "a.md", &ok, "B.md", false).is_err());
        let stale = What::Selection {
            start: 0,
            end: 3,
            expected: "xyz".into(),
        };
        assert!(extract_plan(&v, "a.md", &stale, "n.md", false).is_err());
        let blank = What::Selection {
            start: 3,
            end: 4,
            expected: "\n".into(),
        };
        assert!(extract_plan(&v, "a.md", &blank, "n.md", false).is_err());
        assert!(extract_plan(&v, "a.md", &What::Heading { line: 1 }, "n.md", false).is_err());
    }

    #[test]
    fn merge_appends_rewrites_links_and_trashes_the_source() {
        let plan = merge_plan(
            &[
                ("From.md", "---\ntags: x\n---\n\n# From\ntext [[Into#H]]\n"),
                ("Into.md", "# Into\nhello\n"),
                (
                    "Ref.md",
                    "[[From]] [[From#H|a]] [[From#^b]] ![[From]] [t](From.md) [[Other]]\n",
                ),
                ("Plain.md", "[[Into]]\n"),
            ],
            "From.md",
            "Into.md",
            LinkFormat::Shortest,
        )
        .unwrap();
        assert_eq!(
            content(&plan, "Into.md"),
            "# Into\nhello\n\n# From\ntext [[Into#H]]\n"
        );
        assert_eq!(
            content(&plan, "Ref.md"),
            "[[Into]] [[Into#H|a]] [[Into#^b]] ![[Into]] [t](Into.md) [[Other]]\n"
        );
        assert_eq!(plan.trash.as_deref(), Some("From.md"));
        assert!(plan.writes.iter().all(|w| w.0 != "Plain.md"));
        let actions: Vec<_> = plan
            .changes
            .iter()
            .map(|c| (&c.path[..], c.action))
            .collect();
        assert_eq!(
            actions,
            vec![
                ("Into.md", Action::Append),
                ("Ref.md", Action::Update),
                ("From.md", Action::Trash)
            ]
        );
        assert_eq!(plan.changes[1].links, 5);
    }

    #[test]
    fn merge_keeps_the_names_unique_after_the_merge() {
        // Only Into.md remains by that name, so the shortest form is the bare name.
        let plan = merge_plan(
            &[
                ("a/Note.md", "x"),
                ("b/Into.md", "y"),
                ("Ref.md", "[[a/Note]] [[Note]]\n"),
            ],
            "a/Note.md",
            "b/Into.md",
            LinkFormat::Shortest,
        )
        .unwrap();
        assert_eq!(content(&plan, "Ref.md"), "[[Into]] [[Into]]\n");
        let abs = merge_plan(
            &[
                ("a/Note.md", "x"),
                ("b/Into.md", "y"),
                ("Ref.md", "[[Note]]\n"),
            ],
            "a/Note.md",
            "b/Into.md",
            LinkFormat::Absolute,
        )
        .unwrap();
        assert_eq!(content(&abs, "Ref.md"), "[[b/Into]]\n");
    }

    #[test]
    fn merge_rewrites_the_links_of_the_target_and_of_the_source_itself() {
        let plan = merge_plan(
            &[
                ("From.md", "self [[From#H]] back [[Into]]\n"),
                ("Into.md", "to [[From]]\n"),
            ],
            "From.md",
            "Into.md",
            LinkFormat::Shortest,
        )
        .unwrap();
        assert_eq!(
            content(&plan, "Into.md"),
            "to [[Into]]\n\nself [[Into#H]] back [[Into]]\n"
        );
    }

    #[test]
    fn merge_refuses_bad_input() {
        let v = [("a.md", "a"), ("b.md", "b"), ("img.png", "")];
        let m = |s, t| merge_plan(&v, s, t, LinkFormat::Shortest);
        assert!(m("a.md", "a.md").is_err());
        assert!(m("a.md", "missing.md").is_err());
        assert!(m("img.png", "b.md").is_err());
        assert!(m("a.md", "img.png").is_err());
        assert!(m("a.md", "b.md").is_ok());
    }

    fn tmp(name: &str) -> TestDir {
        TestDir::new(&format!("nixe-composer-{name}-"))
    }

    #[test]
    fn merge_on_disk_writes_the_notes_and_trashes_the_source() {
        let root = tmp("merge");
        fs::write(root.join("From.md"), "from text\n").unwrap();
        fs::write(root.join("Into.md"), "into text\n").unwrap();
        fs::write(root.join("Ref.md"), "see [[From]]\n").unwrap();
        let (from, into) = (root.join("From.md"), root.join("Into.md"));
        let preview = preview_merge(
            &root,
            from.to_str().unwrap(),
            into.to_str().unwrap(),
            |_| None,
        )
        .unwrap();
        assert_eq!(preview.len(), 3);
        assert!(from.exists(), "a preview changes nothing");
        let changes = merge(
            &root,
            from.to_str().unwrap(),
            into.to_str().unwrap(),
            |_| None,
        )
        .unwrap();
        assert_eq!(changes, preview);
        assert_eq!(
            fs::read_to_string(&into).unwrap(),
            "into text\n\nfrom text\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("Ref.md")).unwrap(),
            "see [[Into]]\n"
        );
        assert!(!from.exists());
        assert_eq!(
            fs::read_to_string(root.join(".trash/From.md")).unwrap(),
            "from text\n"
        );
    }

    #[test]
    fn extract_on_disk_creates_the_folder_and_the_note() {
        let root = tmp("extract");
        let text = "# A\nkeep\n## B\nmove\n";
        fs::write(root.join("A.md"), text).unwrap();
        fs::write(root.join("Ref.md"), "[[A#B]]\n").unwrap();
        let source = root.join("A.md");
        let target = root.join("Sub/B.md");
        let what = What::Heading { line: 3 };
        let changes = extract(
            &root,
            source.to_str().unwrap(),
            &what,
            target.to_str().unwrap(),
            false,
            |_| None,
        )
        .unwrap();
        assert_eq!(changes.len(), 3);
        assert_eq!(fs::read_to_string(&target).unwrap(), "## B\nmove\n");
        assert_eq!(fs::read_to_string(&source).unwrap(), "# A\nkeep\n[[B]]\n");
        assert_eq!(
            fs::read_to_string(root.join("Ref.md")).unwrap(),
            "[[B#B]]\n"
        );
        // A second run on the same heading finds nothing to move.
        assert!(extract(
            &root,
            source.to_str().unwrap(),
            &what,
            target.to_str().unwrap(),
            false,
            |_| None
        )
        .is_err());
    }
}
