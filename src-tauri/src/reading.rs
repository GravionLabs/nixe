//! The reading position of an EPUB book (#489): one small JSON file per book in `.nixe/epub/` of
//! the vault, so it travels with git; nothing is written next to the book. The frontend names the
//! book by `key` (the root name and the relative path) and sends the JSON text; this module maps
//! the key to a file name and keeps a damaged file from ever reaching the reader.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Upper bound of one file; a position is a few hundred bytes.
const MAX_BYTES: usize = 64 * 1024;

/// The folder of the files inside the vault.
fn folder(vault: &Path) -> PathBuf {
    vault.join(".nixe").join("epub")
}

/// 64-bit FNV-1a: stable across platforms and releases, so the same book always finds its file.
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, b| {
        (hash ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

/// `<readable part>-<hash>.json`: the readable part is only for a person who looks into the folder,
/// the hash makes the name unique. Never contains a path separator.
fn file_name(key: &str) -> String {
    let readable: String = key
        .rsplit(['/', '\\', ':'])
        .next()
        .unwrap_or("")
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect::<String>()
        .trim_start_matches('.')
        .to_string();
    format!("{readable}-{:016x}.json", fnv1a(key))
}

fn file_of(vault: &Path, key: &str) -> Result<PathBuf, String> {
    if key.trim().is_empty() {
        return Err("no book".into());
    }
    Ok(folder(vault).join(file_name(key)))
}

/// The saved position of the book `key`. A missing, unreadable or damaged file (no JSON object) is
/// no position: `None`, no error.
pub fn read_position(vault: &Path, key: &str) -> Option<String> {
    let text = fs::read_to_string(file_of(vault, key).ok()?).ok()?;
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) if v.is_object() => Some(text),
        _ => None,
    }
}

/// Atomically replaces the file of the book `key` (the folder is created when missing); refuses
/// text that is no JSON object.
pub fn write_position(vault: &Path, key: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_BYTES {
        return Err("reading position too large".into());
    }
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(v) if v.is_object() => {}
        _ => return Err("reading position must be a JSON object".into()),
    }
    let target = file_of(vault, key)?;
    let dir = target.parent().ok_or("no folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".{}.nixe-tmp", file_name(key)));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, &target)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", target.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    fn tmp(name: &str) -> TestDir {
        TestDir::new(&format!("nixe-reading-{name}-"))
    }

    #[test]
    fn a_position_round_trips_in_the_dot_folder() {
        let vault = tmp("round");
        let json = r#"{"root":"Books","path":"a/b.epub","cfi":"epubcfi(/6/4!/4/2)"}"#;
        assert_eq!(read_position(&vault, "Books:a/b.epub"), None);
        write_position(&vault, "Books:a/b.epub", json).unwrap();
        assert_eq!(
            read_position(&vault, "Books:a/b.epub").as_deref(),
            Some(json)
        );
        let files: Vec<_> = fs::read_dir(vault.join(".nixe/epub"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(
            files[0].ends_with(".json") && !files[0].starts_with('.'),
            "{files:?}"
        );
        assert!(files[0].starts_with("b.epub-"), "{files:?}");
    }

    #[test]
    fn a_rewrite_replaces_and_other_books_do_not_collide() {
        let vault = tmp("two");
        write_position(&vault, "V:a.epub", r#"{"cfi":"1"}"#).unwrap();
        write_position(&vault, "V:a.epub", r#"{"cfi":"2"}"#).unwrap();
        write_position(&vault, "V:dir/a.epub", r#"{"cfi":"3"}"#).unwrap();
        assert_eq!(
            read_position(&vault, "V:a.epub").as_deref(),
            Some(r#"{"cfi":"2"}"#)
        );
        assert_eq!(
            read_position(&vault, "V:dir/a.epub").as_deref(),
            Some(r#"{"cfi":"3"}"#)
        );
        assert_eq!(fs::read_dir(vault.join(".nixe/epub")).unwrap().count(), 2);
    }

    #[test]
    fn a_damaged_file_is_ignored() {
        let vault = tmp("damaged");
        write_position(&vault, "V:a.epub", r#"{"cfi":"1"}"#).unwrap();
        let file = folder(&vault).join(file_name("V:a.epub"));
        for bad in ["{\"cfi\":", "[1]", "", "\u{0}\u{1}"] {
            fs::write(&file, bad).unwrap();
            assert_eq!(read_position(&vault, "V:a.epub"), None, "{bad:?}");
        }
        fs::write(&file, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_position(&vault, "V:a.epub"), None);
        // A damaged file does not block the next write.
        write_position(&vault, "V:a.epub", r#"{"cfi":"2"}"#).unwrap();
        assert!(read_position(&vault, "V:a.epub").is_some());
    }

    #[test]
    fn refuses_text_that_is_no_object_and_oversized_text() {
        let vault = tmp("refuse");
        assert!(write_position(&vault, "V:a.epub", "not json").is_err());
        assert!(write_position(&vault, "V:a.epub", "[]").is_err());
        let big = format!(r#"{{"cfi":"{}"}}"#, "x".repeat(MAX_BYTES));
        assert!(write_position(&vault, "V:a.epub", &big).is_err());
        assert!(write_position(&vault, " ", "{}").is_err());
        assert!(!vault.join(".nixe").exists());
    }

    #[test]
    fn the_name_never_leaves_the_folder() {
        for key in ["../../x", "a\\..\\b", "/etc/passwd", "V:..", "é ü/ß"] {
            let name = file_name(key);
            assert!(
                !name.contains(['/', '\\']) && !name.starts_with(".."),
                "{name}"
            );
            assert_eq!(name, file_name(key));
        }
        assert_ne!(file_name("V:a.epub"), file_name("W:a.epub"));
    }

    #[test]
    fn a_vault_without_the_folder_reads_none() {
        assert_eq!(read_position(&tmp("none"), "V:a.epub"), None);
        assert_eq!(
            read_position(Path::new("/nonexistent-nixe"), "V:a.epub"),
            None
        );
    }
}
