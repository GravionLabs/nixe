//! Find and replace across the vault (#115): a preview of every replacement as a diff, and one
//! batch that writes the notes. `.obsidian/`, `.git/` and `.trash/` are never read or written
//! (`walk_vault` skips them, and `apply` refuses their paths).

use std::fs;
use std::path::Path;

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use super::resolve::is_markdown_path;
use super::{walk_vault, SKIPPED_DIRS};
use crate::write;

/// Matches listed per note in a preview; the rest are counted but not listed.
const MAX_MATCHES_PER_NOTE: usize = 200;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub find: String,
    pub replace: String,
    /// `find` is a regular expression; `replace` may use `$1`, `${name}`.
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
}

/// What the user left out of the batch.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclusions {
    /// Vault-relative notes that are left alone.
    #[serde(default)]
    pub notes: Vec<String>,
    /// `(note, match)`: the 0-based match of the note (the `index` of the preview) is kept.
    #[serde(default)]
    pub matches: Vec<(String, usize)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replacement {
    /// 0-based number of the match in its note.
    pub index: usize,
    /// 1-based line where the match starts.
    pub line: usize,
    /// The lines of the match before the replacement.
    pub before: String,
    /// The same lines after it.
    pub after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReplacements {
    pub path: String,
    /// Matches in the note, also those beyond the listed ones.
    pub count: usize,
    pub replacements: Vec<Replacement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub notes: usize,
    pub replacements: usize,
    /// Vault-relative paths of the notes that were written.
    pub paths: Vec<String>,
}

fn build(opts: &Options) -> Result<Regex, String> {
    if opts.find.is_empty() {
        return Err("nothing to find".into());
    }
    let mut pattern = if opts.regex {
        opts.find.clone()
    } else {
        regex::escape(&opts.find)
    };
    if opts.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!opts.case_sensitive)
        .multi_line(true)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| format!("invalid pattern: {e}"))
}

/// The text a match is replaced with.
fn expand(re: &Regex, opts: &Options, text: &str, m: &regex::Match) -> String {
    if !opts.regex {
        return opts.replace.clone();
    }
    // `captures_at` keeps the look-around context of the whole text.
    match re.captures_at(text, m.start()) {
        Some(caps) if caps.get(0).is_some_and(|c| c.start() == m.start()) => {
            let mut out = String::new();
            caps.expand(&opts.replace, &mut out);
            out
        }
        _ => opts.replace.clone(),
    }
}

struct Found {
    start: usize,
    end: usize,
    with: String,
}

/// The non-empty matches of `text`, each with its replacement.
fn find_all(re: &Regex, opts: &Options, text: &str) -> Vec<Found> {
    re.find_iter(text)
        .filter(|m| !m.as_str().is_empty())
        .map(|m| Found {
            start: m.start(),
            end: m.end(),
            with: expand(re, opts, text, &m),
        })
        .collect()
}

fn line_start(text: &str, at: usize) -> usize {
    text[..at].rfind('\n').map_or(0, |i| i + 1)
}

fn line_end(text: &str, at: usize) -> usize {
    text[at..].find('\n').map_or(text.len(), |i| at + i)
}

fn trim_eol(s: &str) -> &str {
    s.strip_suffix('\r').unwrap_or(s)
}

fn is_skipped(path: &str) -> bool {
    path.split('/').any(|part| SKIPPED_DIRS.contains(&part))
}

fn read_note(root: &Path, path: &str) -> Option<String> {
    String::from_utf8(fs::read(root.join(path)).ok()?).ok()
}

fn notes(root: &Path) -> Vec<String> {
    walk_vault(root)
        .into_iter()
        .map(|f| f.path)
        .filter(|p| is_markdown_path(p) && !is_skipped(p))
        .collect()
}

/// Every replacement `opts` would make, per note; writes nothing.
pub fn preview(root: &Path, opts: &Options) -> Result<Vec<NoteReplacements>, String> {
    let re = build(opts)?;
    let mut out = Vec::new();
    for path in notes(root) {
        let Some(text) = read_note(root, &path) else {
            continue;
        };
        let found = find_all(&re, opts, &text);
        if found.is_empty() {
            continue;
        }
        let replacements = found
            .iter()
            .enumerate()
            .take(MAX_MATCHES_PER_NOTE)
            .map(|(index, f)| {
                let from = line_start(&text, f.start);
                let to = line_end(&text, f.end);
                let before = &text[from..to];
                let after = format!("{}{}{}", &text[from..f.start], f.with, &text[f.end..to]);
                Replacement {
                    index,
                    line: text[..f.start].matches('\n').count() + 1,
                    before: trim_eol(before).to_string(),
                    after: trim_eol(&after).to_string(),
                }
            })
            .collect();
        out.push(NoteReplacements {
            path,
            count: found.len(),
            replacements,
        });
    }
    Ok(out)
}

/// `text` with the matches that are not excluded replaced; the number of replacements.
fn replace_text(
    re: &Regex,
    opts: &Options,
    text: &str,
    path: &str,
    excluded: &Exclusions,
) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut n = 0;
    for (index, f) in find_all(re, opts, text).iter().enumerate() {
        if excluded
            .matches
            .iter()
            .any(|(p, i)| p == path && *i == index)
        {
            continue;
        }
        out.push_str(&text[last..f.start]);
        out.push_str(&f.with);
        last = f.end;
        n += 1;
    }
    out.push_str(&text[last..]);
    (out, n)
}

/// Replaces in every note that is not excluded, as one batch: all results are computed before the
/// first write, so an invalid pattern or an unreadable note changes nothing. A failed write is
/// reported after the others went through.
pub fn apply(root: &Path, opts: &Options, excluded: &Exclusions) -> Result<Applied, String> {
    let re = build(opts)?;
    let mut writes = Vec::new();
    let mut replacements = 0;
    for path in notes(root) {
        if excluded.notes.contains(&path) {
            continue;
        }
        let Some(text) = read_note(root, &path) else {
            continue;
        };
        let (new, n) = replace_text(&re, opts, &text, &path, excluded);
        if n > 0 {
            replacements += n;
            writes.push((path, new));
        }
    }
    let mut paths = Vec::new();
    let mut failed = Vec::new();
    for (path, content) in writes {
        match write::write_text_file(root, &root.join(&path), &content) {
            Ok(()) => paths.push(path),
            Err(e) => failed.push(e),
        }
    }
    if !failed.is_empty() {
        return Err(format!(
            "{} of {} notes could not be written: {}",
            failed.len(),
            failed.len() + paths.len(),
            failed.join("; ")
        ));
    }
    Ok(Applied {
        notes: paths.len(),
        replacements,
        paths,
    })
}

/// `apply`, after a commit of the open changes when the vault is a Git repository. Nothing to
/// commit is fine; any other failure of the commit stops before the first write.
pub fn apply_with_checkpoint(
    root: &Path,
    opts: &Options,
    excluded: &Exclusions,
    fallback: Option<&crate::git::Identity>,
) -> Result<Applied, String> {
    build(opts)?;
    if crate::git::vault_status(root)?.is_some() {
        let message = format!(
            "Before replacing \"{}\"",
            opts.find.lines().next().unwrap_or("")
        );
        match crate::git::vault_commit(root, Some(&message), fallback) {
            Ok(_) => {}
            Err(e) if e == "nothing to commit" => {}
            Err(e) => return Err(format!("could not commit before the replacement: {e}")),
        }
    }
    apply(root, opts, excluded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-replace-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    fn opts(find: &str, replace: &str) -> Options {
        Options {
            find: find.into(),
            replace: replace.into(),
            regex: false,
            case_sensitive: false,
            whole_word: false,
        }
    }

    fn put(root: &Path, path: &str, text: &str) {
        let abs = root.join(path);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(abs, text).unwrap();
    }

    fn get(root: &Path, path: &str) -> String {
        fs::read_to_string(root.join(path)).unwrap()
    }

    #[test]
    fn literal_search_ignores_case_by_default_and_treats_regex_characters_literally() {
        let root = temp_dir("literal");
        put(&root, "a.md", "Foo foo FOO a.c abc");
        assert_eq!(
            apply(&root, &opts("foo", "bar"), &Exclusions::default())
                .unwrap()
                .replacements,
            3
        );
        assert_eq!(get(&root, "a.md"), "bar bar bar a.c abc");
        apply(&root, &opts("a.c", "X"), &Exclusions::default()).unwrap();
        assert_eq!(get(&root, "a.md"), "bar bar bar X abc");
    }

    #[test]
    fn case_sensitive_matches_only_the_exact_case() {
        let root = temp_dir("case");
        put(&root, "a.md", "Foo foo FOO");
        let mut o = opts("foo", "bar");
        o.case_sensitive = true;
        apply(&root, &o, &Exclusions::default()).unwrap();
        assert_eq!(get(&root, "a.md"), "Foo bar FOO");
    }

    #[test]
    fn whole_word_skips_matches_inside_words() {
        let root = temp_dir("word");
        put(&root, "a.md", "cat concat cat.");
        let mut o = opts("cat", "dog");
        o.whole_word = true;
        apply(&root, &o, &Exclusions::default()).unwrap();
        assert_eq!(get(&root, "a.md"), "dog concat dog.");
    }

    #[test]
    fn regex_expands_capture_groups_and_anchors_lines() {
        let root = temp_dir("regex");
        put(&root, "a.md", "TODO: one\nx TODO: two\nTODO: three\n");
        let mut o = opts(r"^TODO: (\w+)", "DONE ($1)");
        o.regex = true;
        let applied = apply(&root, &o, &Exclusions::default()).unwrap();
        assert_eq!(applied.replacements, 2);
        assert_eq!(
            get(&root, "a.md"),
            "DONE (one)\nx TODO: two\nDONE (three)\n"
        );
    }

    #[test]
    fn a_literal_replacement_keeps_dollar_signs() {
        let root = temp_dir("dollar");
        put(&root, "a.md", "price");
        apply(&root, &opts("price", "$1 ${x}"), &Exclusions::default()).unwrap();
        assert_eq!(get(&root, "a.md"), "$1 ${x}");
    }

    #[test]
    fn an_invalid_pattern_or_an_empty_find_changes_nothing() {
        let root = temp_dir("invalid");
        put(&root, "a.md", "(x");
        let mut o = opts("(", "y");
        o.regex = true;
        assert!(apply(&root, &o, &Exclusions::default())
            .unwrap_err()
            .starts_with("invalid pattern"));
        assert!(preview(&root, &opts("", "y")).is_err());
        assert_eq!(get(&root, "a.md"), "(x");
    }

    #[test]
    fn config_and_history_folders_and_other_files_are_never_touched() {
        let root = temp_dir("skipped");
        for p in [
            ".obsidian/a.md",
            ".git/b.md",
            ".trash/c.md",
            "sub/.trash/d.md",
            "e.txt",
            "e.json",
        ] {
            put(&root, p, "foo");
        }
        put(&root, "n.md", "foo");
        let listed: Vec<_> = preview(&root, &opts("foo", "x"))
            .unwrap()
            .into_iter()
            .map(|n| n.path)
            .collect();
        assert_eq!(listed, vec!["n.md"]);
        let applied = apply(&root, &opts("foo", "bar"), &Exclusions::default()).unwrap();
        assert_eq!(applied.paths, vec!["n.md"]);
        for p in [
            ".obsidian/a.md",
            ".git/b.md",
            ".trash/c.md",
            "sub/.trash/d.md",
            "e.txt",
            "e.json",
        ] {
            assert_eq!(get(&root, p), "foo", "{p}");
        }
    }

    #[test]
    fn excluded_notes_and_single_matches_stay() {
        let root = temp_dir("exclude");
        put(&root, "a.md", "foo foo foo");
        put(&root, "b.md", "foo");
        put(&root, "c.md", "foo");
        let excluded = Exclusions {
            notes: vec!["b.md".into()],
            matches: vec![("a.md".into(), 1)],
        };
        let applied = apply(&root, &opts("foo", "bar"), &excluded).unwrap();
        assert_eq!((applied.notes, applied.replacements), (2, 3));
        assert_eq!(get(&root, "a.md"), "bar foo bar");
        assert_eq!(get(&root, "b.md"), "foo");
        assert_eq!(get(&root, "c.md"), "bar");
    }

    #[test]
    fn a_note_whose_matches_are_all_excluded_is_not_written() {
        let root = temp_dir("all-excluded");
        put(&root, "a.md", "foo");
        let excluded = Exclusions {
            notes: vec![],
            matches: vec![("a.md".into(), 0)],
        };
        let applied = apply(&root, &opts("foo", "bar"), &excluded).unwrap();
        assert_eq!((applied.notes, applied.replacements), (0, 0));
        assert_eq!(get(&root, "a.md"), "foo");
    }

    #[test]
    fn preview_shows_each_replacement_as_before_and_after_and_writes_nothing() {
        let root = temp_dir("preview");
        put(&root, "a.md", "one\r\nthe foo and foo\r\nend");
        let result = preview(&root, &opts("foo", "bar")).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].count, 2);
        assert_eq!(
            result[0].replacements,
            vec![
                Replacement {
                    index: 0,
                    line: 2,
                    before: "the foo and foo".into(),
                    after: "the bar and foo".into()
                },
                Replacement {
                    index: 1,
                    line: 2,
                    before: "the foo and foo".into(),
                    after: "the foo and bar".into()
                },
            ]
        );
        assert_eq!(get(&root, "a.md"), "one\r\nthe foo and foo\r\nend");
    }

    #[test]
    fn preview_indexes_match_the_exclusions_of_apply() {
        let root = temp_dir("indexes");
        put(&root, "a.md", "foo\nfoo\nfoo");
        let shown = preview(&root, &opts("foo", "bar")).unwrap();
        let skip = shown[0].replacements[2].index;
        let excluded = Exclusions {
            notes: vec![],
            matches: vec![("a.md".into(), skip)],
        };
        apply(&root, &opts("foo", "bar"), &excluded).unwrap();
        assert_eq!(get(&root, "a.md"), "bar\nbar\nfoo");
    }

    #[test]
    fn matches_of_multi_line_regexes_and_empty_matches() {
        let root = temp_dir("multi");
        put(&root, "a.md", "a\nb\nc");
        let mut o = opts(r"a\nb", "X");
        o.regex = true;
        let shown = preview(&root, &o).unwrap();
        assert_eq!(shown[0].replacements[0].before, "a\nb");
        assert_eq!(shown[0].replacements[0].after, "X");
        let mut empty = opts("x*", "-");
        empty.regex = true;
        assert!(preview(&root, &empty).unwrap().is_empty());
    }

    #[test]
    fn a_git_vault_is_committed_before_the_replacement() {
        let root = temp_dir("git");
        let repo = git2::Repository::init(&root).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@example.com").unwrap();
        put(&root, "a.md", "foo");
        let applied =
            apply_with_checkpoint(&root, &opts("foo", "bar"), &Exclusions::default(), None)
                .unwrap();
        assert_eq!(applied.notes, 1);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert!(head.message().unwrap().starts_with("Before replacing"));
        let blob = head
            .tree()
            .unwrap()
            .get_path(Path::new("a.md"))
            .unwrap()
            .to_object(&repo)
            .unwrap();
        assert_eq!(blob.as_blob().unwrap().content(), b"foo");
        assert_eq!(get(&root, "a.md"), "bar");
        // Clean tree: nothing to commit is not an error.
        put(&root, "b.md", "foo");
        git2::Repository::open(&root).unwrap();
        assert!(
            apply_with_checkpoint(&root, &opts("foo", "baz"), &Exclusions::default(), None).is_ok()
        );
    }

    #[test]
    fn a_vault_without_git_is_replaced_without_a_commit() {
        let root = temp_dir("nogit");
        put(&root, "a.md", "foo");
        apply_with_checkpoint(&root, &opts("foo", "bar"), &Exclusions::default(), None).unwrap();
        assert_eq!(get(&root, "a.md"), "bar");
        assert!(!root.join(".git").exists());
    }

    #[test]
    fn non_utf8_notes_are_skipped() {
        let root = temp_dir("binary");
        fs::write(root.join("bin.md"), [0xff, 0xfe, b'f', b'o', b'o']).unwrap();
        assert!(preview(&root, &opts("foo", "bar")).unwrap().is_empty());
    }
}
