//! Themes and CSS snippets (#114): `.css` files in `themes/` and `snippets/` of the app config
//! directory. The frontend lists them, applies the chosen theme and the enabled snippets, and reads
//! them again when `modified` changes. Nothing is read from a vault, `.obsidian/themes` and
//! `.obsidian/snippets` target Obsidian's DOM.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Folder of the themes inside the app config directory.
pub const THEMES_DIR: &str = "themes";
/// Folder of the snippets inside the app config directory.
pub const SNIPPETS_DIR: &str = "snippets";
/// Upper bound for one file; a bigger one is skipped.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// One CSS file with the content it had when it was read.
#[derive(Debug, PartialEq, Serialize)]
pub struct CssFile {
    /// File name without `.css`; the id the settings store.
    pub name: String,
    /// Modification time in milliseconds since the epoch; changes when the file changes.
    pub modified: u64,
    pub css: String,
}

/// The folder for `kind` (`themes` or `snippets`); refuses anything else.
fn folder(dir: &Path, kind: &str) -> Result<std::path::PathBuf, String> {
    match kind {
        THEMES_DIR | SNIPPETS_DIR => Ok(dir.join(kind)),
        _ => Err(format!("unknown kind: {kind}")),
    }
}

/// Creates the `themes/` and `snippets/` folders so the user finds them.
pub fn ensure_folders(dir: &Path) -> Result<(), String> {
    for kind in [THEMES_DIR, SNIPPETS_DIR] {
        let path = dir.join(kind);
        fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}

/// The `.css` files of `kind` in `dir`, sorted by name. A missing folder is an empty list; files
/// that are hidden, no regular file, too big or no UTF-8 are left out.
pub fn read_css(dir: &Path, kind: &str) -> Result<Vec<CssFile>, String> {
    let path = folder(dir, kind)?;
    let entries = match fs::read_dir(&path) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let file = entry.path();
        let Some(name) = file
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".css"))
        else {
            continue;
        };
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let Ok(meta) = fs::metadata(&file) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_BYTES {
            continue;
        }
        let Ok(css) = fs::read_to_string(&file) else {
            continue;
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        files.push(CssFile {
            name: name.to_string(),
            modified,
            css,
        });
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-appearance-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn a_missing_folder_is_an_empty_list() {
        let dir = tmp("missing");
        assert_eq!(read_css(&dir, THEMES_DIR), Ok(Vec::new()));
    }

    #[test]
    fn ensure_folders_creates_both() {
        let dir = tmp("ensure");
        ensure_folders(&dir).unwrap();
        assert!(dir.join("themes").is_dir() && dir.join("snippets").is_dir());
    }

    #[test]
    fn lists_css_files_sorted_and_skips_the_rest() {
        let dir = tmp("list");
        ensure_folders(&dir).unwrap();
        let s = dir.join(SNIPPETS_DIR);
        fs::write(s.join("b.css"), "b{}").unwrap();
        fs::write(s.join("A.css"), "a{}").unwrap();
        fs::write(s.join("notes.txt"), "x").unwrap();
        fs::write(s.join(".hidden.css"), "x").unwrap();
        fs::write(s.join(".css"), "x").unwrap();
        fs::create_dir(s.join("dir.css")).unwrap();
        fs::write(s.join("binary.css"), [0xff, 0xfe, 0xfd]).unwrap();
        let files = read_css(&dir, SNIPPETS_DIR).unwrap();
        let names: Vec<_> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["A", "b"]);
        assert_eq!(files[0].css, "a{}");
        assert!(files[0].modified > 0);
    }

    #[test]
    fn themes_and_snippets_are_separate() {
        let dir = tmp("kinds");
        ensure_folders(&dir).unwrap();
        fs::write(dir.join(THEMES_DIR).join("t.css"), "t{}").unwrap();
        assert_eq!(read_css(&dir, THEMES_DIR).unwrap().len(), 1);
        assert!(read_css(&dir, SNIPPETS_DIR).unwrap().is_empty());
    }

    #[test]
    fn refuses_an_unknown_kind() {
        let dir = tmp("kind");
        assert!(read_css(&dir, "../etc").is_err());
    }

    #[test]
    fn a_changed_file_changes_its_content() {
        let dir = tmp("change");
        ensure_folders(&dir).unwrap();
        let f = dir.join(SNIPPETS_DIR).join("x.css");
        fs::write(&f, "a{}").unwrap();
        assert_eq!(read_css(&dir, SNIPPETS_DIR).unwrap()[0].css, "a{}");
        fs::write(&f, "b{}").unwrap();
        assert_eq!(read_css(&dir, SNIPPETS_DIR).unwrap()[0].css, "b{}");
    }
}
