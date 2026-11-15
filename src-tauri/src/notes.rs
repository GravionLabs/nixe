//! Note files of the editor prototype (#59). The webview only ever names a file
//! inside `<documents dir>/vault`; it never supplies a path.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

const SAMPLE_NAME: &str = "sample.md";
const LONG_NAME: &str = "long-2000-lines.md";
const LONG_LINES: usize = 2000;
/// Largest note the editor reads or writes.
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// The only directory the editor may touch.
pub fn notes_dir(documents_dir: &Path) -> PathBuf {
    documents_dir.join("vault")
}

/// A plain file name: no separators, no parent references, a markdown extension.
fn checked_name(name: &str) -> Result<&str, String> {
    let plain = !name.is_empty()
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0'])
        && name.ends_with(".md");
    if plain {
        Ok(name)
    } else {
        Err(format!("invalid note name: {name}"))
    }
}

fn sample_note() -> String {
    let mut s = String::from(
        "# Nixe editor prototype\n\nThis is **bold** text, some *italic* and `code`.\n\n## Tasks\n\n- [ ] open a note\n- [x] type something\n- [ ] try **bold tasks** too\n\n",
    );
    for i in 1..=40 {
        s.push_str(&format!(
            "Line {i}: the quick **brown** fox jumps over the lazy dog.\n"
        ));
    }
    s
}

fn long_note() -> String {
    let mut s = String::new();
    for i in 1..=LONG_LINES {
        match i % 10 {
            1 => s.push_str(&format!("## Section {i}\n")),
            2 => s.push_str(&format!("- [ ] task on line {i}\n")),
            3 => s.push_str(&format!("Line {i} with **bold** and *italic* text.\n")),
            _ => s.push_str(&format!(
                "Line {i}: lorem ipsum dolor sit amet, consectetur.\n"
            )),
        }
    }
    s
}

/// Creates the folder and the seed notes that are missing; existing files are kept.
pub fn seed(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    for (name, content) in [(SAMPLE_NAME, sample_note()), (LONG_NAME, long_note())] {
        let path = dir.join(name);
        if !path.exists() {
            fs::write(path, content)?;
        }
    }
    Ok(())
}

/// A regular file that is not a symlink (symlinks could point out of the vault).
fn is_plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
}

pub fn list(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| is_plain_file(&e.path()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| checked_name(n).is_ok())
        .collect();
    names.sort();
    Ok(names)
}

pub fn read(dir: &Path, name: &str) -> Result<String, String> {
    let path = dir.join(checked_name(name)?);
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !meta.file_type().is_file() {
        return Err(format!("not a regular file: {name}"));
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("note too large: {name}"));
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Writes through a temp file in the same folder and renames it over the note.
pub fn write(dir: &Path, name: &str, content: &str) -> Result<(), String> {
    let path = dir.join(checked_name(name)?);
    if content.len() as u64 > MAX_BYTES {
        return Err(format!("note too large: {name}"));
    }
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if !meta.file_type().is_file() {
            return Err(format!("not a regular file: {name}"));
        }
    }
    let tmp = dir.join(format!(".{name}.tmp"));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Turns what the document picker returns (a percent-encoded `file://` URL or a plain path) into a path.
pub fn picked_path(raw: &str) -> Result<PathBuf, String> {
    let Some(rest) = raw.strip_prefix("file://") else {
        return Ok(PathBuf::from(raw));
    };
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = rest
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| format!("invalid percent sequence in {raw}"))?;
            out.push(hex);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out)
        .map(PathBuf::from)
        .map_err(|_| format!("path is not valid UTF-8: {raw}"))
}

/// Spike only (#59): the decoded path, shown in the status text.
#[tauri::command]
pub fn spike_external_path(path: String) -> Result<String, String> {
    picked_path(&path).map(|p| p.to_string_lossy().into_owned())
}

/// Spike only (#59): read a file the document picker returned, to test iCloud access.
/// Disabled in release builds because the path comes from the webview.
#[tauri::command]
pub fn spike_external_read(path: String) -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Err("only available in debug builds".into());
    }
    fs::read_to_string(picked_path(&path)?).map_err(|e| e.to_string())
}

/// Spike only (#59): write back to a picked file; debug builds only.
#[tauri::command]
pub fn spike_external_write(path: String, content: String) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("only available in debug builds".into());
    }
    fs::write(picked_path(&path)?, content).map_err(|e| e.to_string())
}

fn dir_of(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    let dir = notes_dir(&docs);
    seed(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn notes_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    list(&dir_of(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_read(app: tauri::AppHandle, name: String) -> Result<String, String> {
    read(&dir_of(&app)?, &name)
}

#[tauri::command]
pub fn notes_write(app: tauri::AppHandle, name: String, content: String) -> Result<(), String> {
    write(&dir_of(&app)?, &name, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-notes-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn notes_dir_is_vault_below_documents() {
        assert_eq!(notes_dir(Path::new("/docs")), Path::new("/docs/vault"));
    }

    #[test]
    fn seed_creates_sample_and_2000_line_note() {
        let dir = tmp("seed");
        seed(&dir).unwrap();
        assert_eq!(list(&dir).unwrap(), vec![LONG_NAME, SAMPLE_NAME]);
        assert_eq!(read(&dir, LONG_NAME).unwrap().lines().count(), 2000);
        assert!(read(&dir, SAMPLE_NAME)
            .unwrap()
            .contains("- [ ] open a note"));
    }

    #[test]
    fn seed_keeps_edited_notes() {
        let dir = tmp("keep");
        seed(&dir).unwrap();
        write(&dir, SAMPLE_NAME, "mine").unwrap();
        seed(&dir).unwrap();
        assert_eq!(read(&dir, SAMPLE_NAME).unwrap(), "mine");
    }

    #[test]
    fn write_then_read_roundtrips_and_lists_new_note() {
        let dir = tmp("rt");
        seed(&dir).unwrap();
        write(&dir, "new.md", "# ü\n").unwrap();
        assert_eq!(read(&dir, "new.md").unwrap(), "# ü\n");
        assert!(list(&dir).unwrap().contains(&"new.md".to_string()));
    }

    #[test]
    fn rejects_names_outside_the_folder() {
        let dir = tmp("bad");
        seed(&dir).unwrap();
        for bad in ["../x.md", "a/b.md", "", ".hidden.md", "x.txt", "..\\x.md"] {
            assert!(read(&dir, bad).is_err(), "{bad}");
            assert!(write(&dir, bad, "x").is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_nul_and_absolute_names() {
        let dir = tmp("nul");
        seed(&dir).unwrap();
        for bad in ["a\0.md", "/etc/passwd.md", "/abs/x.md", "C:\\x.md"] {
            assert!(read(&dir, bad).is_err(), "{bad:?}");
            assert!(write(&dir, bad, "x").is_err(), "{bad:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_when_listing_reading_and_writing() {
        let dir = tmp("link");
        seed(&dir).unwrap();
        let outside = tmp("link-outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("link.md")).unwrap();
        assert!(!list(&dir).unwrap().contains(&"link.md".to_string()));
        assert!(read(&dir, "link.md").is_err());
        assert!(write(&dir, "link.md", "changed").is_err());
        assert_eq!(
            fs::read_to_string(outside.join("secret.md")).unwrap(),
            "secret"
        );
    }

    #[test]
    fn write_leaves_no_temp_file_and_replaces_content() {
        let dir = tmp("atomic");
        seed(&dir).unwrap();
        write(&dir, SAMPLE_NAME, "one").unwrap();
        write(&dir, SAMPLE_NAME, "two").unwrap();
        assert_eq!(read(&dir, SAMPLE_NAME).unwrap(), "two");
        let files: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert!(files.iter().all(|f| !f.to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn enforces_the_size_limit_on_write_and_read() {
        let dir = tmp("size");
        seed(&dir).unwrap();
        let big = "x".repeat(MAX_BYTES as usize + 1);
        assert!(write(&dir, "big.md", &big).is_err());
        assert!(!dir.join("big.md").exists());
        fs::write(dir.join("big.md"), &big).unwrap();
        assert!(read(&dir, "big.md").is_err());
        let ok = "x".repeat(MAX_BYTES as usize);
        write(&dir, "ok.md", &ok).unwrap();
        assert_eq!(read(&dir, "ok.md").unwrap().len(), ok.len());
    }

    #[test]
    fn picked_path_decodes_file_urls() {
        assert_eq!(
            picked_path("file:///private/var/My%20Docs/n%C3%BCx.md").unwrap(),
            Path::new("/private/var/My Docs/nüx.md")
        );
    }

    #[test]
    fn picked_path_passes_plain_paths_through() {
        assert_eq!(
            picked_path("/a/b%20c.md").unwrap(),
            Path::new("/a/b%20c.md")
        );
    }

    #[test]
    fn picked_path_rejects_invalid_percent_sequences() {
        assert!(picked_path("file:///a%zz.md").is_err());
        assert!(picked_path("file:///a%2").is_err());
        assert!(picked_path("file:///a%FF.md").is_err());
    }

    #[test]
    fn reading_a_missing_note_fails() {
        let dir = tmp("missing");
        seed(&dir).unwrap();
        assert!(read(&dir, "nope.md").is_err());
    }
}
