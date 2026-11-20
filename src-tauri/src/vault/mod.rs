//! Vault detection and the in-memory file list used to resolve `[[wikilinks]]`.
//! Read-only: opening a vault never writes into it.

use std::path::{Path, PathBuf};

use ignore::WalkBuilder;

// Not called yet: the vault index (a later item of the same feature) is the first user.
pub mod composer;
#[allow(dead_code)]
pub mod meta;
pub mod relink;
#[allow(dead_code)]
pub mod resolve;

pub(crate) const SKIPPED_DIRS: &[&str] = &[".obsidian", ".git", ".trash"];

/// The topmost ancestor of `path` (or `path` itself) that contains `.obsidian/`;
/// without one, the opened folder (or the file's folder) is the vault root.
pub fn find_vault_root(path: &Path) -> PathBuf {
    let start = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    start
        .ancestors()
        .filter(|dir| dir.join(".obsidian").is_dir())
        .last()
        .unwrap_or(start)
        .to_path_buf()
}

/// A file found by `walk_vault`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultFile {
    /// Relative to the vault root, forward slashes.
    pub path: String,
    pub size: u64,
    /// Modification time in nanoseconds since the Unix epoch (0 when unknown).
    pub mtime_ns: i64,
}

/// Every file below `root`, sorted by path.
/// `.obsidian/`, `.git/`, `.trash/` and `.gitignore`d paths are skipped.
pub fn walk_vault(root: &Path) -> Vec<VaultFile> {
    let mut files: Vec<VaultFile> = WalkBuilder::new(root)
        .hidden(false)
        // `.gitignore` applies even where there is no `.git` directory.
        .require_git(false)
        .git_global(false)
        .git_exclude(false)
        .filter_entry(|entry| {
            let skipped = entry.depth() > 0
                && entry.file_type().is_some_and(|t| t.is_dir())
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|n| SKIPPED_DIRS.contains(&n));
            !skipped
        })
        .build()
        .flatten()
        .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
        .filter_map(|entry| {
            let rel = entry.path().strip_prefix(root).ok()?;
            let meta = entry.metadata().ok()?;
            let mtime_ns = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos() as i64);
            Some(VaultFile {
                path: rel.to_string_lossy().replace('\\', "/"),
                size: meta.len(),
                mtime_ns,
            })
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

/// Every file below `root` as a relative path with forward slashes, sorted.
pub fn list_vault_files(root: &Path) -> Vec<String> {
    walk_vault(root).into_iter().map(|f| f.path).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-vault-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    /// Sorted (path, content) pairs of everything below `root`, for before/after comparisons.
    fn snapshot(root: &Path) -> Vec<(String, Option<String>)> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let p = entry.path();
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                if p.is_dir() {
                    out.push((rel, None));
                    stack.push(p);
                } else {
                    out.push((rel, Some(fs::read_to_string(&p).unwrap())));
                }
            }
        }
        out.sort();
        out
    }

    #[test]
    fn root_is_folder_with_obsidian_dir() {
        let root = temp_dir("present");
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        assert_eq!(find_vault_root(&root.join("notes")), root);
        assert_eq!(find_vault_root(&root.join("notes/a.md")), root);
    }

    #[test]
    fn root_without_obsidian_is_the_opened_folder() {
        let root = temp_dir("absent");
        fs::create_dir_all(root.join("notes")).unwrap();
        assert_eq!(find_vault_root(&root.join("notes")), root.join("notes"));
    }

    #[test]
    fn nested_vaults_resolve_to_the_topmost() {
        let root = temp_dir("nested");
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::create_dir_all(root.join("inner/.obsidian")).unwrap();
        assert_eq!(find_vault_root(&root.join("inner")), root);
    }

    #[test]
    fn lists_files_and_skips_internal_and_ignored_paths() {
        let root = temp_dir("list");
        for dir in [".obsidian", ".git", ".trash", "sub", "build"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in [
            "a.md",
            "sub/b.md",
            ".obsidian/app.json",
            ".git/HEAD",
            ".trash/old.md",
            "build/out.md",
            "secret.md",
        ] {
            fs::write(root.join(file), "x").unwrap();
        }
        fs::write(root.join(".gitignore"), "build/\nsecret.md\n").unwrap();
        assert_eq!(
            list_vault_files(&root),
            vec![".gitignore", "a.md", "sub/b.md"]
        );
    }

    #[test]
    fn opening_a_vault_leaves_it_unchanged() {
        let root = temp_dir("readonly");
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(root.join(".obsidian/app.json"), "{}").unwrap();
        fs::write(root.join("a.md"), "[[b]]").unwrap();
        let before = snapshot(&root);
        let found = find_vault_root(&root);
        let _ = list_vault_files(&found);
        assert_eq!(snapshot(&root), before);
    }
}
