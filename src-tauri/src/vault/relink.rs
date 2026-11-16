//! Keeps links working when notes or folders are renamed or moved (#70), like Obsidian's
//! `alwaysUpdateLinks`: `[[wikilinks]]`, `![[embeds]]` and Markdown links that point to a moved
//! file are rewritten in the notes that contain them, in the form `newLinkFormat` asks for.
//!
//! `plan` is pure (file lists and note texts in, new texts out). `rename_with_links` reads every
//! affected note first, renames, then writes all rewritten notes in one burst, so the vault
//! watcher reports one debounced batch.
//!
//! Not rewritten: links in the frontmatter, links inside code spans, fenced code and `%%comments%%`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::Serialize;

use super::meta::{closes_fence, find_backtick_run, has_scheme, opens_fence, percent_decode};
use super::meta::{split_frontmatter, Fence};
use super::resolve::{is_markdown_path, Resolver};
use crate::write;

/// The path form of new links, from `newLinkFormat` of `.obsidian/app.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LinkFormat {
    /// The shortest path that still names the note (Obsidian's default).
    #[default]
    Shortest,
    /// Relative to the note that holds the link.
    Relative,
    /// From the vault root.
    Absolute,
}

/// `newLinkFormat` of the vault; `Shortest` when the file or the key is missing or unknown.
pub fn link_format(root: &Path) -> LinkFormat {
    let value = fs::read_to_string(root.join(".obsidian").join("app.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|j| j.get("newLinkFormat")?.as_str().map(str::to_string));
    match value.as_deref() {
        Some("relative") => LinkFormat::Relative,
        Some("absolute") => LinkFormat::Absolute,
        _ => LinkFormat::Shortest,
    }
}

/// A file that changes its path; both vault-relative with forward slashes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub from: String,
    pub to: String,
}

/// A note with rewritten links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rewrite {
    /// Path before the move.
    pub from: String,
    /// Path after the move (equal to `from` for a note that stays).
    pub to: String,
    pub content: String,
    /// Number of links changed.
    pub links: usize,
}

/// A note whose links change, as shown in the confirmation of a folder rename.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    /// Vault-relative path after the rename.
    pub path: String,
    pub links: usize,
}

/// The notes of `candidates` and of the moved files that hold links to be rewritten.
/// `files` is the vault before the move; `read` returns the text of a note by its old path.
pub fn plan(
    files: &[String],
    moves: &[Move],
    format: LinkFormat,
    candidates: &[String],
    read: impl Fn(&str) -> Option<String>,
) -> Vec<Rewrite> {
    if moves.is_empty() {
        return Vec::new();
    }
    let moved: HashMap<&str, &str> = moves
        .iter()
        .map(|m| (m.from.as_str(), m.to.as_str()))
        .collect();
    let new_files: Vec<String> = files
        .iter()
        .map(|f| moved.get(f.as_str()).map_or(f.as_str(), |t| *t).to_string())
        .collect();
    let ctx = Context {
        moved: &moved,
        format,
        old_files: files.iter().map(String::as_str).collect(),
        old_lower: files
            .iter()
            .map(|f| (f.to_lowercase(), f.as_str()))
            .collect(),
        old: Resolver::new(files),
        new: Resolver::new(&new_files),
    };
    let mut sources: Vec<&str> = candidates
        .iter()
        .map(String::as_str)
        .chain(moves.iter().map(|m| m.from.as_str()))
        .filter(|p| is_markdown_path(p) && ctx.old_files.contains(p))
        .collect();
    sources.sort_unstable();
    sources.dedup();
    sources
        .into_iter()
        .filter_map(|from| {
            let text = read(from)?;
            let to = moved.get(from).copied().unwrap_or(from);
            let (content, links) = rewrite_note(&text, from, to, &ctx);
            (links > 0).then(|| Rewrite {
                from: from.to_string(),
                to: to.to_string(),
                content,
                links,
            })
        })
        .collect()
}

struct Context<'a> {
    moved: &'a HashMap<&'a str, &'a str>,
    format: LinkFormat,
    old_files: HashSet<&'a str>,
    old_lower: HashMap<String, &'a str>,
    old: Resolver,
    new: Resolver,
}

fn rewrite_note(text: &str, from: &str, to: &str, ctx: &Context) -> (String, usize) {
    let (bom, text) = match text.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", text),
    };
    let body_start = split_frontmatter(text).map_or(0, |(_, body)| text.len() - body.len());
    let mut out = String::with_capacity(text.len() + 64);
    out.push_str(bom);
    out.push_str(&text[..body_start]);
    let mut fence: Option<Fence> = None;
    let mut in_comment = false;
    let mut total = 0;
    for raw in text[body_start..].split_inclusive('\n') {
        let line = raw.trim_end_matches(['\n', '\r']);
        let ending = &raw[line.len()..];
        if let Some(open) = &fence {
            if closes_fence(line, open) {
                fence = None;
            }
            out.push_str(raw);
            continue;
        }
        if !in_comment {
            if let Some(open) = opens_fence(line) {
                fence = Some(open);
                out.push_str(raw);
                continue;
            }
        }
        let masked = mask(line, &mut in_comment);
        let mut edits = link_edits(line, &masked, from, to, ctx);
        total += edits.len();
        edits.sort_by_key(|e| e.start);
        let mut at = 0;
        for e in &edits {
            out.push_str(&line[at..e.start]);
            out.push_str(&e.text);
            at = e.end;
        }
        out.push_str(&line[at..]);
        out.push_str(ending);
    }
    (out, total)
}

/// `line` with code spans and `%%comments%%` replaced by spaces; same byte length, so offsets
/// in the result are offsets in `line`. `in_comment` carries a comment across lines.
fn mask(line: &str, in_comment: &mut bool) -> String {
    let mut bytes = line.as_bytes().to_vec();
    let mut i = 0;
    while i < bytes.len() {
        if *in_comment {
            let end = line[i..].find("%%").map(|e| i + e + 2);
            let stop = end.unwrap_or(bytes.len());
            bytes[i..stop].fill(b' ');
            *in_comment = end.is_none();
            i = stop;
        } else if bytes[i] == b'`' {
            let n = bytes[i..].iter().take_while(|b| **b == b'`').count();
            match find_backtick_run(&line[i + n..], n) {
                Some(close) => {
                    let end = i + n + close + n;
                    bytes[i..end].fill(b' ');
                    i = end;
                }
                None => i += n,
            }
        } else if line[i..].starts_with("%%") {
            *in_comment = true;
            bytes[i..i + 2].fill(b' ');
            i += 2;
        } else {
            i += 1;
        }
    }
    // Only whole characters were blanked (the delimiters are ASCII), so this stays valid UTF-8.
    String::from_utf8(bytes).unwrap_or_else(|_| line.to_string())
}

struct Edit {
    start: usize,
    end: usize,
    text: String,
}

fn link_edits(line: &str, masked: &str, from: &str, to: &str, ctx: &Context) -> Vec<Edit> {
    let bytes = masked.as_bytes();
    let mut edits = Vec::new();
    let mut open_brackets: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'[' if bytes.get(i + 1) == Some(&b'[') => {
                if let Some(end) = masked[i + 2..].find("]]").map(|e| e + i + 2) {
                    let inner = &masked[i + 2..end];
                    if !inner.trim().is_empty()
                        && !inner.contains('[')
                        && !inner.trim().eq_ignore_ascii_case("_toc_")
                    {
                        edits.extend(wikilink_edit(line, i + 2, end, to, ctx));
                        i = end + 2;
                        continue;
                    }
                }
                open_brackets.push(i);
            }
            b'[' => open_brackets.push(i),
            b']' if bytes.get(i + 1) == Some(&b'(') && !open_brackets.is_empty() => {
                open_brackets.pop();
                if let Some((start, end, close)) = destination(masked, i + 2) {
                    edits.extend(markdown_edit(line, start, end, from, to, ctx));
                    i = close;
                    continue;
                }
            }
            b']' => {
                open_brackets.pop();
            }
            _ => {}
        }
        i += 1;
    }
    edits
}

/// The destination of `(…)` after `](`: its `start..end` and the offset after the `)`.
fn destination(line: &str, from: usize) -> Option<(usize, usize, usize)> {
    let rest = &line[from..];
    let close = rest.find(')')?;
    let lead = rest[..close].len() - rest[..close].trim_start().len();
    let inside = &rest[lead..close];
    let (start, len) = if let Some(angle) = inside.strip_prefix('<') {
        (from + lead + 1, angle.find('>')?)
    } else {
        (
            from + lead,
            inside.split_whitespace().next().map_or(0, str::len),
        )
    };
    Some((start, start + len, from + close + 1))
}

fn wikilink_edit(
    line: &str,
    inner_start: usize,
    inner_end: usize,
    to: &str,
    ctx: &Context,
) -> Option<Edit> {
    let inner = &line[inner_start..inner_end];
    let target_end = inner.find(['#', '|']).unwrap_or(inner.len());
    let raw = &inner[..target_end];
    let target = raw.trim();
    if target.is_empty() {
        return None;
    }
    let old = ctx.old.resolve(target)?;
    let new = ctx.moved.get(old.as_str())?;
    let start = inner_start + (raw.len() - raw.trim_start().len());
    // A note is written without `.md` unless the link had an extension.
    let strip = new.to_lowercase().ends_with(".md") && !is_markdown_path(target);
    let text = path_text(new, to, strip, ctx);
    (text != target).then_some(Edit {
        start,
        end: start + target.len(),
        text,
    })
}

fn markdown_edit(
    line: &str,
    start: usize,
    end: usize,
    from: &str,
    to: &str,
    ctx: &Context,
) -> Option<Edit> {
    let dest = &line[start..end];
    if dest.is_empty() || dest.starts_with('#') || has_scheme(dest) {
        return None;
    }
    let path_len = dest.find('#').unwrap_or(dest.len());
    let path = percent_decode(&dest[..path_len]);
    let (old, relative) = match relative_target(&path, from, ctx) {
        Some(found) => (found, true),
        None => (ctx.old.resolve(&path)?, false),
    };
    let target_moved = ctx.moved.get(old.as_str()).copied();
    // A moved note keeps its relative links working by recomputing them.
    let source_moved = from != to && relative && !path.starts_with('/');
    let new = match target_moved {
        Some(new) => new,
        None if source_moved => old.as_str(),
        None => return None,
    };
    let text = path_text(new, to, false, ctx);
    let angle = line[..start].ends_with('<');
    let text = if angle {
        text
    } else {
        encode_destination(&text)
    };
    (text != dest[..path_len]).then_some(Edit {
        start,
        end: start + path_len,
        text,
    })
}

/// The file a Markdown link path names relative to the note `from` (or the vault root for a
/// leading `/`), found by exact path first, then ignoring case.
fn relative_target(path: &str, from: &str, ctx: &Context) -> Option<String> {
    let joined = match path.strip_prefix('/') {
        Some(rooted) => normalize(rooted)?,
        None => {
            let dir = from.rsplit_once('/').map_or("", |(d, _)| d);
            normalize(&format!("{dir}/{path}"))?
        }
    };
    if ctx.old_files.contains(joined.as_str()) {
        return Some(joined);
    }
    ctx.old_lower
        .get(&joined.to_lowercase())
        .map(|f| f.to_string())
}

/// Folds `.` and `..`; `None` when the path leaves the vault.
fn normalize(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    let unified = path.replace('\\', "/");
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    // `parts` borrows from the temporary above, so join through owned strings.
    Some(
        parts
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// How `target` (vault-relative, after the move) is written in the note `source` (after the move).
fn path_text(target: &str, source: &str, strip_md: bool, ctx: &Context) -> String {
    let unextended = |p: &str| {
        if strip_md {
            p[..p.len() - ".md".len()].to_string()
        } else {
            p.to_string()
        }
    };
    match ctx.format {
        LinkFormat::Absolute => unextended(target),
        LinkFormat::Relative => unextended(&relative_path(source, target)),
        LinkFormat::Shortest => {
            let parts: Vec<&str> = target.split('/').collect();
            for k in 1..parts.len() {
                let candidate = unextended(&parts[parts.len() - k..].join("/"));
                if ctx.new.resolve(&candidate).as_deref() == Some(target) {
                    return candidate;
                }
            }
            unextended(target)
        }
    }
}

/// `target` as seen from the folder of `source`; both vault-relative.
fn relative_path(source: &str, target: &str) -> String {
    let dir: Vec<&str> = source
        .rsplit_once('/')
        .map_or(Vec::new(), |(d, _)| d.split('/').collect());
    let to: Vec<&str> = target.split('/').collect();
    let common = dir
        .iter()
        .zip(&to[..to.len() - 1])
        .take_while(|(a, b)| a == b)
        .count();
    let mut out: Vec<&str> = vec![".."; dir.len() - common];
    out.extend(&to[common..]);
    out.join("/")
}

fn encode_destination(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '%' => out.push_str("%25"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            c => out.push(c),
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------------------------

/// The vault-relative form of `path`, forward slashes; `None` when it is not below `root`.
fn relative_to(root: &Path, path: &Path) -> Option<String> {
    let canonical = dunce::canonicalize(root).ok();
    let rel = path
        .strip_prefix(root)
        .ok()
        .or_else(|| canonical.as_deref().and_then(|c| path.strip_prefix(c).ok()))?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// The files that move when `from` becomes `to`: the file itself or every file below the folder.
fn moves_of(files: &[String], from: &str, to: &str) -> Vec<Move> {
    let folder = format!("{from}/");
    files
        .iter()
        .filter_map(|f| {
            if f == from {
                Some(Move {
                    from: f.clone(),
                    to: to.to_string(),
                })
            } else {
                f.strip_prefix(&folder).map(|rest| Move {
                    from: f.clone(),
                    to: format!("{to}/{rest}"),
                })
            }
        })
        .collect()
}

/// The rewrites a rename of `from` to `to` would make. `referrers` names the notes that link to
/// the given files (the index); `None` means it cannot tell and every note is checked.
pub fn plan_rename(
    root: &Path,
    from: &Path,
    to: &Path,
    referrers: impl Fn(&[String]) -> Option<Vec<String>>,
) -> Vec<Rewrite> {
    let (Some(from), Some(to)) = (relative_to(root, from), relative_to(root, to)) else {
        return Vec::new();
    };
    let files = super::list_vault_files(root);
    let moves = moves_of(&files, &from, &to);
    let targets: Vec<String> = moves.iter().map(|m| m.from.clone()).collect();
    let candidates = if targets.is_empty() {
        Vec::new()
    } else {
        referrers(&targets).unwrap_or_else(|| files.clone())
    };
    plan(&files, &moves, link_format(root), &candidates, |path| {
        let bytes = fs::read(root.join(path)).ok()?;
        String::from_utf8(bytes).ok()
    })
}

/// What a rename of `from` to `to` would change, for the confirmation.
pub fn preview(
    root: &Path,
    from: &Path,
    to: &Path,
    referrers: impl Fn(&[String]) -> Option<Vec<String>>,
) -> Vec<Change> {
    plan_rename(root, from, to, referrers)
        .into_iter()
        .map(|r| Change {
            path: r.to,
            links: r.links,
        })
        .collect()
}

/// Renames `from` to `to` and rewrites the links to it, in one go: the notes are read before
/// the rename and written right after it. Nothing is written when the rename fails.
pub fn rename_with_links(
    root: &Path,
    from: &Path,
    to: &Path,
    referrers: impl Fn(&[String]) -> Option<Vec<String>>,
) -> Result<Vec<Change>, String> {
    let rewrites = plan_rename(root, from, to, referrers);
    crate::fileops::rename_path(root, from, to)?;
    let mut changes = Vec::new();
    let mut failed = Vec::new();
    for r in rewrites {
        match write::write_text_file(root, &root.join(&r.to), &r.content) {
            Ok(()) => changes.push(Change {
                path: r.to,
                links: r.links,
            }),
            Err(e) => failed.push(e),
        }
    }
    if failed.is_empty() {
        Ok(changes)
    } else {
        Err(format!(
            "renamed, but links could not be updated: {}",
            failed.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn mv(from: &str, to: &str) -> Vec<Move> {
        vec![Move {
            from: from.into(),
            to: to.into(),
        }]
    }

    /// Rewrites `text` in `a.md` (which stays) after `from` moved to `to`.
    fn run(vault: &[&str], from: &str, to: &str, format: LinkFormat, text: &str) -> String {
        let vault = files(vault);
        let source = "a.md".to_string();
        let texts = HashMap::from([(source.clone(), text.to_string())]);
        let got = plan(&vault, &mv(from, to), format, &[source], |p| {
            texts.get(p).cloned()
        });
        got.into_iter()
            .next()
            .map_or_else(|| text.to_string(), |r| r.content)
    }

    fn shortest(vault: &[&str], from: &str, to: &str, text: &str) -> String {
        run(vault, from, to, LinkFormat::Shortest, text)
    }

    #[test]
    fn renames_wikilinks_and_keeps_alias_heading_and_block() {
        let v = ["a.md", "Old.md"];
        let got = shortest(
            &v,
            "Old.md",
            "New.md",
            "[[Old]] [[Old|shown]] [[Old#Head]] [[Old#^abc|x]] [[ Old#H | y ]] ![[Old]] [[Other]]",
        );
        assert_eq!(
            got,
            "[[New]] [[New|shown]] [[New#Head]] [[New#^abc|x]] [[ New#H | y ]] ![[New]] [[Other]]"
        );
    }

    #[test]
    fn an_explicit_extension_stays() {
        let got = shortest(
            &["a.md", "Old.md"],
            "Old.md",
            "New.md",
            "[[Old.md]] [[Old]]",
        );
        assert_eq!(got, "[[New.md]] [[New]]");
    }

    #[test]
    fn matches_case_insensitively_and_by_path() {
        let v = ["a.md", "d/Old.md"];
        let got = shortest(&v, "d/Old.md", "d/New.md", "[[old]] [[d/Old]] [[D/old|x]]");
        assert_eq!(got, "[[New]] [[New]] [[New|x]]");
    }

    #[test]
    fn rewrites_markdown_links_and_images() {
        let v = ["a.md", "Old note.md", "img.png"];
        let got = shortest(
            &v,
            "Old note.md",
            "My note.md",
            "[t](Old%20note.md#Head) [u](<Old note.md>) ![i](img.png) [web](https://x.y/Old%20note.md)",
        );
        assert_eq!(
            got,
            "[t](My%20note.md#Head) [u](<My note.md>) ![i](img.png) [web](https://x.y/Old%20note.md)"
        );
        let got = shortest(
            &["a.md", "img.png"],
            "img.png",
            "pics/img.png",
            "![i](img.png) ![[img.png]]",
        );
        assert_eq!(got, "![i](img.png) ![[img.png]]");
        let got = run(
            &["a.md", "img.png"],
            "img.png",
            "pics/img.png",
            LinkFormat::Absolute,
            "![i](img.png) ![[img.png]]",
        );
        assert_eq!(got, "![i](pics/img.png) ![[pics/img.png]]");
    }

    #[test]
    fn shortest_adds_folders_only_when_the_name_is_taken() {
        let v = ["a.md", "Old.md", "x/Twin.md"];
        assert_eq!(shortest(&v, "Old.md", "y/Moved.md", "[[Old]]"), "[[Moved]]");
        assert_eq!(shortest(&v, "Old.md", "y/Twin.md", "[[Old]]"), "[[y/Twin]]");
        let deep = ["a.md", "Old.md", "p/q/Twin.md", "r/q/Twin.md"];
        assert_eq!(
            shortest(&deep, "Old.md", "s/q/Twin.md", "[[Old]]"),
            "[[s/q/Twin]]"
        );
    }

    #[test]
    fn absolute_and_relative_forms() {
        let v = ["d/a.md", "Old.md"];
        let text = "[[Old#H|x]] [m](Old.md)";
        let abs = run(
            &["a.md", "Old.md"],
            "Old.md",
            "x/y/New.md",
            LinkFormat::Absolute,
            text,
        );
        assert_eq!(abs, "[[x/y/New#H|x]] [m](x/y/New.md)");
        // The source is d/a.md in this vault, so a.md below is not the note.
        let vault = files(&v);
        let texts = HashMap::from([("d/a.md".to_string(), text.to_string())]);
        let rel = plan(
            &vault,
            &mv("Old.md", "x/y/New.md"),
            LinkFormat::Relative,
            &["d/a.md".to_string()],
            |p| texts.get(p).cloned(),
        );
        assert_eq!(rel[0].content, "[[../x/y/New#H|x]] [m](../x/y/New.md)");
        let sibling = plan(
            &vault,
            &mv("Old.md", "d/New.md"),
            LinkFormat::Relative,
            &["d/a.md".to_string()],
            |p| texts.get(p).cloned(),
        );
        assert_eq!(sibling[0].content, "[[New#H|x]] [m](New.md)");
    }

    #[test]
    fn leaves_code_comments_and_frontmatter_alone() {
        let v = ["a.md", "Old.md"];
        let text = "---\nrelated: \"[[Old]]\"\n---\n`[[Old]]` and [[Old]]\n```\n[[Old]]\n```\n%% [[Old]] %%\n%%\n[[Old]]\n%%\n``a `[[Old]]` b``\n[[Old]]\n";
        let got = shortest(&v, "Old.md", "New.md", text);
        let expect = "---\nrelated: \"[[Old]]\"\n---\n`[[Old]]` and [[New]]\n```\n[[Old]]\n```\n%% [[Old]] %%\n%%\n[[Old]]\n%%\n``a `[[Old]]` b``\n[[New]]\n";
        assert_eq!(got, expect);
    }

    #[test]
    fn keeps_line_endings_and_bom() {
        let got = shortest(
            &["a.md", "Old.md"],
            "Old.md",
            "New.md",
            "\u{feff}x [[Old]]\r\ny\r\n[[Old]]",
        );
        assert_eq!(got, "\u{feff}x [[New]]\r\ny\r\n[[New]]");
    }

    #[test]
    fn ambiguous_or_missing_targets_are_left_alone() {
        let v = ["a.md", "Old.md", "d/Twin.md", "e/Twin.md"];
        let text = "[[Missing]] [[Twin]] [[#Head]] [[Old]]";
        assert_eq!(
            shortest(&v, "Old.md", "New.md", text),
            "[[Missing]] [[Twin]] [[#Head]] [[New]]"
        );
        assert_eq!(
            shortest(&v, "d/Twin.md", "d/Other.md", "[[Twin]] [[e/Twin]]"),
            "[[Twin]] [[e/Twin]]"
        );
    }

    #[test]
    fn a_moved_note_updates_its_own_links() {
        let vault = files(&["a.md", "d/Old.md", "d/Sib.md"]);
        let texts = HashMap::from([(
            "d/Old.md".to_string(),
            "[[Old#H]] [s](Sib.md) [[Sib]]".to_string(),
        )]);
        let got = plan(
            &vault,
            &mv("d/Old.md", "e/New.md"),
            LinkFormat::Shortest,
            &[],
            |p| texts.get(p).cloned(),
        );
        assert_eq!(got.len(), 1);
        assert_eq!(
            (got[0].from.as_str(), got[0].to.as_str()),
            ("d/Old.md", "e/New.md")
        );
        // `Sib.md` still resolves from e/ by its name, so only the wikilink to the note itself changes.
        assert_eq!(got[0].content, "[[New#H]] [s](Sib.md) [[Sib]]");
        assert_eq!(got[0].links, 1);
    }

    #[test]
    fn a_moved_note_keeps_relative_markdown_links_working() {
        let vault = files(&["d/Old.md", "d/Sib.md"]);
        let texts = HashMap::from([(
            "d/Old.md".to_string(),
            "[s](./Sib.md) [t](../d/Sib.md)".to_string(),
        )]);
        let got = plan(
            &vault,
            &mv("d/Old.md", "e/Old.md"),
            LinkFormat::Relative,
            &[],
            |p| texts.get(p).cloned(),
        );
        assert_eq!(got[0].content, "[s](../d/Sib.md) [t](../d/Sib.md)");
    }

    #[test]
    fn a_folder_move_rewrites_links_to_every_note_in_it() {
        let vault = files(&["a.md", "dir/One.md", "dir/sub/Two.md"]);
        let moves = moves_of(&vault, "dir", "moved");
        assert_eq!(moves.len(), 2);
        let texts = HashMap::from([(
            "a.md".to_string(),
            "[[dir/One]] [[Two|2]] ![[sub/Two]]".to_string(),
        )]);
        let got = plan(
            &vault,
            &moves,
            LinkFormat::Absolute,
            &["a.md".to_string()],
            |p| texts.get(p).cloned(),
        );
        assert_eq!(
            got[0].content,
            "[[moved/One]] [[moved/sub/Two|2]] ![[moved/sub/Two]]"
        );
        assert_eq!(got[0].links, 3);
    }

    #[test]
    fn notes_without_changes_are_not_returned() {
        let vault = files(&["a.md", "Old.md", "b.md"]);
        let texts = HashMap::from([("a.md".to_string(), "[[b]]".to_string())]);
        let got = plan(
            &vault,
            &mv("Old.md", "New.md"),
            LinkFormat::Shortest,
            &["a.md".to_string()],
            |p| texts.get(p).cloned(),
        );
        assert!(got.is_empty());
    }

    #[test]
    fn reads_the_link_format_from_app_json() {
        let root = std::env::temp_dir().join(format!("nixe-relink-fmt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        assert_eq!(link_format(&root), LinkFormat::Shortest);
        for (value, want) in [
            ("relative", LinkFormat::Relative),
            ("absolute", LinkFormat::Absolute),
            ("shortest", LinkFormat::Shortest),
            ("odd", LinkFormat::Shortest),
        ] {
            fs::write(
                root.join(".obsidian/app.json"),
                format!("{{\"newLinkFormat\":\"{value}\"}}"),
            )
            .unwrap();
            assert_eq!(link_format(&root), want, "{value}");
        }
        fs::write(root.join(".obsidian/app.json"), "not json").unwrap();
        assert_eq!(link_format(&root), LinkFormat::Shortest);
    }

    fn vault(name: &str, notes: &[(&str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("nixe-relink-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for (path, text) in notes {
            let p = root.join(path);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        dunce::canonicalize(root).unwrap()
    }

    #[test]
    fn renames_on_disk_and_updates_the_referring_notes() {
        let root = vault(
            "disk",
            &[
                ("Old.md", "# Old\n[[Old#Old]] itself\n"),
                ("a.md", "see [[Old|the note]] and [[Other]]\n"),
                ("sub/b.md", "![[Old]] [x](../Old.md)\n"),
                ("c.md", "no links\n"),
            ],
        );
        let seen = std::cell::RefCell::new(Vec::new());
        let changes = rename_with_links(&root, &root.join("Old.md"), &root.join("New.md"), |t| {
            seen.borrow_mut().extend(t.iter().cloned());
            Some(vec!["a.md".into(), "sub/b.md".into()])
        })
        .unwrap();
        assert_eq!(*seen.borrow(), ["Old.md"]);
        let read = |p: &str| fs::read_to_string(root.join(p)).unwrap();
        assert!(!root.join("Old.md").exists());
        assert_eq!(read("New.md"), "# Old\n[[New#Old]] itself\n");
        assert_eq!(read("a.md"), "see [[New|the note]] and [[Other]]\n");
        assert_eq!(read("sub/b.md"), "![[New]] [x](New.md)\n");
        assert_eq!(read("c.md"), "no links\n");
        let mut paths: Vec<_> = changes.iter().map(|c| c.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, ["New.md", "a.md", "sub/b.md"]);
    }

    #[test]
    fn without_an_index_every_note_is_checked() {
        let root = vault(
            "noindex",
            &[("Old.md", ""), ("a.md", "[[Old]]"), ("b.md", "[[Old]]")],
        );
        rename_with_links(&root, &root.join("Old.md"), &root.join("New.md"), |_| None).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "[[New]]");
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "[[New]]");
    }

    #[test]
    fn a_folder_rename_previews_and_rewrites() {
        let root = vault(
            "folder",
            &[
                ("dir/One.md", "x"),
                ("dir/Two.md", "[[One]]"),
                ("a.md", "[[dir/One]] [[Two]]"),
            ],
        );
        let referrers = |_: &[String]| Some(vec!["a.md".to_string()]);
        let preview = preview(&root, &root.join("dir"), &root.join("new"), referrers);
        // dir/Two.md moves and links to One, which moves along: nothing to rewrite there.
        assert_eq!(
            preview,
            vec![Change {
                path: "a.md".into(),
                links: 1
            }]
        );
        assert!(root.join("dir").exists(), "a preview changes nothing");
        rename_with_links(&root, &root.join("dir"), &root.join("new"), referrers).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("a.md")).unwrap(),
            "[[One]] [[Two]]"
        );
    }

    #[test]
    fn a_failed_rename_writes_nothing() {
        let root = vault(
            "fail",
            &[("Old.md", ""), ("Taken.md", ""), ("a.md", "[[Old]]")],
        );
        let err = rename_with_links(&root, &root.join("Old.md"), &root.join("Taken.md"), |_| {
            None
        });
        assert!(err.is_err());
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "[[Old]]");
    }
}
