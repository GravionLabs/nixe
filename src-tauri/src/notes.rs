//! Note files of the editor prototype (#59). The webview only ever names a file
//! inside `<documents dir>/vault`; it never supplies a path.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

const SAMPLE_NAME: &str = "sample.md";
const LONG_NAME: &str = "long-2000-lines.md";
const LONG_LINES: usize = 2000;

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
            _ => s.push_str(&format!("Line {i}: lorem ipsum dolor sit amet, consectetur.\n")),
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

pub fn list(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| checked_name(n).is_ok())
        .collect();
    names.sort();
    Ok(names)
}

pub fn read(dir: &Path, name: &str) -> Result<String, String> {
    fs::read_to_string(dir.join(checked_name(name)?)).map_err(|e| e.to_string())
}

pub fn write(dir: &Path, name: &str, content: &str) -> Result<(), String> {
    fs::write(dir.join(checked_name(name)?), content).map_err(|e| e.to_string())
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
        assert!(read(&dir, SAMPLE_NAME).unwrap().contains("- [ ] open a note"));
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
    fn reading_a_missing_note_fails() {
        let dir = tmp("missing");
        seed(&dir).unwrap();
        assert!(read(&dir, "nope.md").is_err());
    }
}
