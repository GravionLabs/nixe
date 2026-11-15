//! Link resolution by Obsidian's rules. Mirrors `wikilink-resolver.ts`.

use std::collections::HashMap;

/// A wikilink target split into note, heading and block id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkTarget {
    /// Note part without heading/block; empty for a link to the current note (`[[#Heading]]`).
    pub note: String,
    /// `[[Note#Heading]]`
    pub heading: Option<String>,
    /// `[[Note#^block]]`
    pub block: Option<String>,
}

/// Splits the target of a wikilink (without alias) into note, heading and block id.
pub fn parse_target(target: &str) -> LinkTarget {
    let (note, fragment) = match target.find('#') {
        Some(i) => (&target[..i], target[i + 1..].trim()),
        None => (target, ""),
    };
    let note = note.trim().replace('\\', "/");
    let note = note.trim_start_matches('/').to_string();
    if let Some(block) = fragment.strip_prefix('^') {
        return LinkTarget {
            note,
            heading: None,
            block: non_empty(block),
        };
    }
    LinkTarget {
        note,
        heading: non_empty(fragment),
        block: None,
    }
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

const MARKDOWN_EXTENSIONS: &[&str] = &[".md", ".markdown", ".mdown", ".mkd", ".mdx"];

/// True for paths with a Markdown extension (case-insensitive).
pub fn is_markdown_path(path: &str) -> bool {
    let base = path.trim_end_matches('/');
    let base = base.rsplit('/').next().unwrap_or(base);
    match base.rfind('.') {
        Some(i) if i > 0 => MARKDOWN_EXTENSIONS.contains(&base[i..].to_lowercase().as_str()),
        _ => false,
    }
}

/// Maps a wikilink target to a path in `files` (vault-relative, forward slashes): an exact
/// relative path first, then a unique basename anywhere in the vault; case-insensitive.
/// Returns `None` when the target is missing or ambiguous.
pub fn resolve_link<S: AsRef<str>>(target: &str, files: &[S]) -> Option<String> {
    let note = parse_target(target).note;
    if note.is_empty() {
        return None;
    }
    let names: Vec<String> = if is_markdown_path(&note) {
        vec![note]
    } else {
        vec![format!("{note}.md"), note]
    };

    for name in &names {
        if let Some(f) = files.iter().find(|f| f.as_ref() == name) {
            return Some(f.as_ref().to_string());
        }
    }
    for name in &names {
        let lower = name.to_lowercase();
        let exact: Vec<&str> = files
            .iter()
            .map(AsRef::as_ref)
            .filter(|f| f.to_lowercase() == lower)
            .collect();
        match exact.len() {
            1 => return Some(exact[0].to_string()),
            0 => {}
            _ => return None,
        }
        // "folder/Note" or "Note": the path or basename anywhere in the vault.
        let suffix_key = format!("/{lower}");
        let suffix: Vec<&str> = files
            .iter()
            .map(AsRef::as_ref)
            .filter(|f| f.to_lowercase().ends_with(&suffix_key))
            .collect();
        match suffix.len() {
            1 => return Some(suffix[0].to_string()),
            0 => {}
            _ => return None,
        }
    }
    None
}

/// `resolve_link` with the file list indexed once, for resolving many links against one vault.
pub struct Resolver {
    files: Vec<String>,
    exact: HashMap<String, usize>,
    /// Lowercased path to the files with that path.
    lower: HashMap<String, Vec<usize>>,
    /// Lowercased tail after each `/` to the files ending with it.
    tails: HashMap<String, Vec<usize>>,
}

impl Resolver {
    pub fn new<S: AsRef<str>>(files: &[S]) -> Self {
        let files: Vec<String> = files.iter().map(|f| f.as_ref().to_string()).collect();
        let mut exact = HashMap::new();
        let mut lower: HashMap<String, Vec<usize>> = HashMap::new();
        let mut tails: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, f) in files.iter().enumerate() {
            exact.entry(f.clone()).or_insert(i);
            let l = f.to_lowercase();
            for (pos, _) in l.match_indices('/') {
                tails.entry(l[pos + 1..].to_string()).or_default().push(i);
            }
            lower.entry(l).or_default().push(i);
        }
        Resolver {
            files,
            exact,
            lower,
            tails,
        }
    }

    /// Same result as `resolve_link(target, files)`.
    pub fn resolve(&self, target: &str) -> Option<String> {
        let note = parse_target(target).note;
        if note.is_empty() {
            return None;
        }
        let names: Vec<String> = if is_markdown_path(&note) {
            vec![note]
        } else {
            vec![format!("{note}.md"), note]
        };
        for name in &names {
            if let Some(&i) = self.exact.get(name) {
                return Some(self.files[i].clone());
            }
        }
        for name in &names {
            let lower = name.to_lowercase();
            for map in [&self.lower, &self.tails] {
                match map.get(&lower).map(Vec::as_slice) {
                    Some([only]) => return Some(self.files[*only].clone()),
                    Some(more) if more.len() > 1 => return None,
                    _ => {}
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILES: &[&str] = &[
        "Note.md",
        "Index.md",
        "folder/Deep.md",
        "folder/Twin.md",
        "other/Twin.md",
        "assets/image.svg",
        "assets/doc.pdf",
    ];

    fn r(t: &str) -> Option<String> {
        resolve_link(t, FILES)
    }

    #[test]
    fn splits_note_heading_and_block() {
        let t = parse_target("Note#Second heading");
        assert_eq!(t.note, "Note");
        assert_eq!(t.heading.as_deref(), Some("Second heading"));
        let t = parse_target("/a\\b#^id");
        assert_eq!((t.note.as_str(), t.block.as_deref()), ("a/b", Some("id")));
        assert_eq!(parse_target("#Top").note, "");
    }

    #[test]
    fn exact_path_then_unique_basename() {
        assert_eq!(r("Note").as_deref(), Some("Note.md"));
        assert_eq!(r("folder/Deep").as_deref(), Some("folder/Deep.md"));
        assert_eq!(r("Deep").as_deref(), Some("folder/Deep.md"));
        assert_eq!(r("Deep.md").as_deref(), Some("folder/Deep.md"));
        assert_eq!(r("image.svg").as_deref(), Some("assets/image.svg"));
    }

    #[test]
    fn is_case_insensitive() {
        assert_eq!(r("note").as_deref(), Some("Note.md"));
        assert_eq!(r("note.MD").as_deref(), Some("Note.md"));
        assert_eq!(r("FOLDER/deep").as_deref(), Some("folder/Deep.md"));
    }

    #[test]
    fn exact_path_beats_a_basename_match() {
        let files = ["Twin.md", "a/Twin.md"];
        assert_eq!(resolve_link("Twin", &files).as_deref(), Some("Twin.md"));
        assert_eq!(resolve_link("a/Twin", &files).as_deref(), Some("a/Twin.md"));
    }

    #[test]
    fn missing_and_ambiguous_do_not_resolve() {
        assert_eq!(r("Missing"), None);
        assert_eq!(r("Twin"), None);
        assert_eq!(r("#Heading"), None);
        assert_eq!(r("other/Twin").as_deref(), Some("other/Twin.md"));
    }

    #[test]
    fn resolver_agrees_with_resolve_link() {
        let resolver = Resolver::new(FILES);
        for t in [
            "Note",
            "folder/Deep",
            "Deep",
            "Deep.md",
            "image.svg",
            "note",
            "note.MD",
            "FOLDER/deep",
            "Missing",
            "Twin",
            "#Heading",
            "other/Twin",
            "Note#H",
            "doc.pdf",
        ] {
            assert_eq!(resolver.resolve(t), resolve_link(t, FILES), "{t}");
        }
    }
}
