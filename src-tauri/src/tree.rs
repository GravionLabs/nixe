//! Directory listing for the sidebar tree.

use std::path::Path;

use serde::Serialize;

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];
/// Books the reader opens (ADR 0009); they are listed next to the notes.
const BOOK_EXTENSIONS: &[&str] = &["epub"];
const SKIPPED_DIRS: &[&str] = &["node_modules", "target"];
/// Upper bound of directory entries inspected when checking whether a folder
/// contains markdown at all; beyond that the folder is simply shown.
const SCAN_BUDGET: usize = 2000;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Directory contains an Azure DevOps `.order` file.
    pub has_order: bool,
    /// Last modification in milliseconds since the Unix epoch; 0 when unknown.
    pub modified: u64,
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MARKDOWN_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn is_book(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| BOOK_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// A file the tree shows: a note or a book.
fn is_listed(path: &Path) -> bool {
    is_markdown(path) || is_book(path)
}

fn is_visible_dir(name: &str) -> bool {
    !name.starts_with('.') && !SKIPPED_DIRS.contains(&name)
}

/// True if `dir` (recursively) contains a markdown file or a book.
fn contains_markdown(dir: &Path, budget: &mut usize) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        if *budget == 0 {
            return true;
        }
        *budget -= 1;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if is_visible_dir(&name) {
                subdirs.push(path);
            }
        } else if is_listed(&path) {
            return true;
        }
    }
    subdirs.iter().any(|d| contains_markdown(d, budget))
}

/// Folders (that contain markdown or books), markdown files and `.epub` books of `dir`.
///
/// Sorted like the Azure DevOps wiki: names listed in `.order` first (in that
/// order), then the rest with folders before files, alphabetically.
pub fn list_dir(dir: &Path) -> Result<Vec<DirEntry>, String> {
    let order: Vec<String> = std::fs::read_to_string(dir.join(".order"))
        .map(|s| {
            s.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = path.is_dir();
        let visible = if is_dir {
            let mut budget = SCAN_BUDGET;
            is_visible_dir(&name) && contains_markdown(&path, &mut budget)
        } else {
            !name.starts_with('.') && is_listed(&path)
        };
        if visible {
            entries.push(DirEntry {
                has_order: is_dir && path.join(".order").is_file(),
                modified: modified_ms(&path),
                path: crate::path_to_string(&path),
                name,
                is_dir,
            });
        }
    }

    let rank = |e: &DirEntry| {
        let key = if e.is_dir {
            e.name.as_str()
        } else {
            Path::new(&e.name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&e.name)
        };
        order.iter().position(|o| o == key).unwrap_or(usize::MAX)
    };
    entries.sort_by_cached_key(|e| (rank(e), !e.is_dir, e.name.to_lowercase()));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_markdown_sorted_by_order_file() {
        let root = std::env::temp_dir().join(format!("nixe-tree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Zeta")).unwrap();
        fs::create_dir_all(root.join("Empty")).unwrap();
        fs::create_dir_all(root.join(".attachments")).unwrap();
        fs::write(root.join("Zeta/page.md"), "").unwrap();
        fs::write(root.join("Home.md"), "").unwrap();
        fs::write(root.join("Alpha.md"), "").unwrap();
        fs::write(root.join("Beta.md"), "").unwrap();
        fs::write(root.join("image.png"), "").unwrap();
        fs::write(root.join(".order"), "Home\nZeta\n").unwrap();

        let names: Vec<String> = list_dir(&root)
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["Home.md", "Zeta", "Alpha.md", "Beta.md"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reports_the_modified_time_in_milliseconds() {
        let root = std::env::temp_dir().join(format!("nixe-tree-mtime-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Note.md"), "").unwrap();
        let entries = list_dir(&root).unwrap();
        // After 2001-09-09 in milliseconds, so not seconds and not the 0 of an unknown time.
        assert!(entries[0].modified > 1_000_000_000_000);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn lists_epub_books_and_folders_that_hold_only_books() {
        let root = std::env::temp_dir().join(format!("nixe-tree-epub-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Shelf/Sub")).unwrap();
        fs::create_dir_all(root.join("Pictures")).unwrap();
        fs::write(root.join("Shelf/Sub/Novel.EPUB"), "").unwrap();
        fs::write(root.join("Book.epub"), "").unwrap();
        fs::write(root.join("Pictures/a.png"), "").unwrap();
        let names: Vec<String> = list_dir(&root)
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["Shelf", "Book.epub"]);
        let inner: Vec<String> = list_dir(&root.join("Shelf/Sub"))
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(inner, ["Novel.EPUB"]);
        fs::remove_dir_all(&root).unwrap();
    }
}
