//! Bookmarks (#111): notes, headings and searches. They live in `.obsidian/bookmarks.json` of the
//! vault (Obsidian's format) when the user lets Nixe write there, else in `bookmarks.json` of the
//! app data directory, one entry per vault.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// File name of the bookmarks inside `.obsidian/` and inside the app data directory.
pub const BOOKMARKS_FILE: &str = "bookmarks.json";
/// Upper bound for either file.
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// The bookmarks file of a vault; it is only written when `.obsidian/` exists.
fn vault_file(root: &Path) -> PathBuf {
    root.join(".obsidian").join(BOOKMARKS_FILE)
}

fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Atomically replaces `target`; refuses text that is no JSON object, so a bug in the frontend
/// cannot wipe the bookmarks.
fn write(target: &Path, content: &str) -> Result<(), String> {
    if content.len() > MAX_BYTES {
        return Err("bookmarks too large".into());
    }
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(v) if v.is_object() => {}
        _ => return Err("bookmarks must be a JSON object".into()),
    }
    let dir = target.parent().ok_or("no folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".{BOOKMARKS_FILE}.nixe-tmp"));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, target)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", target.display())
    })
}

/// `.obsidian/bookmarks.json` of the vault; `None` when the vault has none.
pub fn read_vault(root: &Path) -> Result<Option<String>, String> {
    read(&vault_file(root))
}

/// Replaces `.obsidian/bookmarks.json`; refuses a vault without `.obsidian/`.
pub fn write_vault(root: &Path, content: &str) -> Result<(), String> {
    if !root.join(".obsidian").is_dir() {
        return Err("the vault has no .obsidian folder".into());
    }
    write(&vault_file(root), content)
}

/// The bookmarks of all vaults in the app data directory `dir`; `None` when there are none yet.
pub fn read_app(dir: &Path) -> Result<Option<String>, String> {
    read(&dir.join(BOOKMARKS_FILE))
}

/// Replaces the bookmarks of the app data directory `dir` (created when missing).
pub fn write_app(dir: &Path, content: &str) -> Result<(), String> {
    write(&dir.join(BOOKMARKS_FILE), content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-bookmarks-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn missing_files_read_as_none() {
        let dir = tmp("missing");
        assert_eq!(read_app(&dir), Ok(None));
        assert_eq!(read_vault(&dir), Ok(None));
    }

    #[test]
    fn app_bookmarks_round_trip_and_create_the_directory() {
        let dir = tmp("app");
        write_app(&dir, r#"{"/v":{"items":[]}}"#).unwrap();
        assert_eq!(
            read_app(&dir).unwrap().as_deref(),
            Some(r#"{"/v":{"items":[]}}"#)
        );
        assert!(!dir.join(format!(".{BOOKMARKS_FILE}.nixe-tmp")).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn vault_bookmarks_need_an_obsidian_folder() {
        let root = tmp("vault");
        fs::create_dir_all(&root).unwrap();
        assert!(write_vault(&root, "{}").is_err());
        assert!(!root.join(".obsidian").exists());
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        write_vault(&root, r#"{"items":[{"type":"file","path":"a.md"}]}"#).unwrap();
        assert_eq!(
            read_vault(&root).unwrap().as_deref(),
            Some(r#"{"items":[{"type":"file","path":"a.md"}]}"#)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_text_that_is_no_object_and_oversized_text() {
        let dir = tmp("refuse");
        for bad in ["", "[1]", "null", "not json"] {
            assert!(write_app(&dir, bad).is_err(), "{bad}");
        }
        assert!(!dir.join(BOOKMARKS_FILE).exists());
        let big = format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_BYTES));
        assert!(write_app(&dir, &big).is_err());
    }
}
