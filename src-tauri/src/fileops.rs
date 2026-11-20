//! File operations of the sidebar (#69): create, rename and trash, all confined to the vault root.
//! Every path is checked after symlinks are resolved, so a link cannot lead out of the root.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Where Obsidian puts a new note, from `.obsidian/app.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNoteLocation {
    /// `root`, `current` or `folder`.
    pub location: String,
    /// Vault-relative folder for `folder`, forward slashes; empty otherwise.
    pub folder: String,
}

/// The new-note folder setting; the vault root when the file or the keys are missing or invalid.
pub fn new_note_location(root: &Path) -> NewNoteLocation {
    let default = NewNoteLocation {
        location: "root".into(),
        folder: String::new(),
    };
    let Ok(text) = fs::read_to_string(root.join(".obsidian").join("app.json")) else {
        return default;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return default;
    };
    let folder = json
        .get("newFileFolderPath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    match json.get("newFileLocation").and_then(|v| v.as_str()) {
        Some("current") => NewNoteLocation {
            location: "current".into(),
            folder: String::new(),
        },
        Some("folder") if !folder.is_empty() => NewNoteLocation {
            location: "folder".into(),
            folder,
        },
        _ => default,
    }
}

/// The template folder of the Templates plugin, from `.obsidian/templates.json` (`folder`);
/// vault-relative with forward slashes. `None` when the file or the key is missing, invalid or empty.
pub fn template_folder(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join(".obsidian").join("templates.json")).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let folder = json
        .get("folder")?
        .as_str()?
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    (!folder.is_empty()).then_some(folder)
}

/// The Daily notes plugin settings from `.obsidian/daily-notes.json`; a key that is missing, empty
/// or not a string is `None`. Folder and template are vault-relative with forward slashes.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DailyNotesConfig {
    pub folder: Option<String>,
    pub format: Option<String>,
    pub template: Option<String>,
}

pub fn daily_notes_config(root: &Path) -> DailyNotesConfig {
    let Some(json) = fs::read_to_string(root.join(".obsidian").join("daily-notes.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
    else {
        return DailyNotesConfig::default();
    };
    let text = |key: &str| json.get(key).and_then(|v| v.as_str()).map(str::trim);
    let path = |key: &str| {
        text(key)
            .map(|v| v.replace('\\', "/").trim_matches('/').to_string())
            .filter(|v| !v.is_empty())
    };
    DailyNotesConfig {
        folder: path("folder"),
        format: text("format").filter(|v| !v.is_empty()).map(str::to_string),
        template: path("template"),
    }
}

pub(crate) fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    dunce::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))
}

fn plain_name(path: &Path) -> Result<&std::ffi::OsStr, String> {
    path.file_name()
        .filter(|n| *n != "." && *n != "..")
        .ok_or_else(|| format!("not a path of the vault: {}", path.display()))
}

/// The canonical form of `path` (which need not exist) when it lies strictly below `root`.
/// The existing part is canonicalized, so symlinks are resolved before the check; `..` is refused.
pub(crate) fn confined(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = canonical_root(root)?;
    if path.components().any(|c| c == Component::ParentDir) {
        return Err(format!("outside the vault: {}", path.display()));
    }
    let mut existing = path;
    let mut missing = Vec::new();
    while fs::symlink_metadata(existing).is_err() {
        missing.push(plain_name(existing)?);
        existing = existing
            .parent()
            .ok_or_else(|| format!("outside the vault: {}", path.display()))?;
    }
    let mut resolved =
        dunce::canonicalize(existing).map_err(|e| format!("{}: {e}", existing.display()))?;
    for name in missing.into_iter().rev() {
        resolved.push(name);
    }
    if resolved == root || !resolved.starts_with(&root) {
        return Err(format!("outside the vault: {}", path.display()));
    }
    Ok(resolved)
}

/// Like `confined`, but the last component is not followed when it is a symlink: the link itself
/// is the subject of a rename or trash, not what it points to.
fn confined_entry(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let name = plain_name(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("outside the vault: {}", path.display()))?;
    let parent = confined_or_root(root, parent)?;
    let entry = parent.join(name);
    if fs::symlink_metadata(&entry).is_err() {
        return Err(format!("{}: no such file or folder", path.display()));
    }
    Ok(entry)
}

pub(crate) fn confined_or_root(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canon_root = canonical_root(root)?;
    match dunce::canonicalize(path) {
        Ok(p) if p == canon_root => Ok(p),
        _ => confined(root, path),
    }
}

/// Creates the empty file `path`; its folder must exist. Never overwrites.
pub fn create_file(root: &Path, path: &Path) -> Result<(), String> {
    let name = plain_name(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("outside the vault: {}", path.display()))?;
    let target = confined_or_root(root, parent)?.join(name);
    if !target.starts_with(canonical_root(root)?) {
        return Err(format!("outside the vault: {}", path.display()));
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map(|_| ())
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Creates the folder `path` and its missing parents.
pub fn create_dir(root: &Path, path: &Path) -> Result<(), String> {
    let target = confined(root, path)?;
    fs::create_dir_all(&target).map_err(|e| format!("{}: {e}", path.display()))
}

/// Moves `from` to `to` inside the vault; refuses to replace anything.
pub fn rename_path(root: &Path, from: &Path, to: &Path) -> Result<(), String> {
    let from_abs = confined_entry(root, from)?;
    let to_name = plain_name(to)?;
    let to_parent = to
        .parent()
        .ok_or_else(|| format!("outside the vault: {}", to.display()))?;
    let to_abs = confined_or_root(root, to_parent)?.join(to_name);
    if !to_abs.starts_with(canonical_root(root)?) {
        return Err(format!("outside the vault: {}", to.display()));
    }
    if from_abs == to_abs {
        return Ok(());
    }
    if to_abs.starts_with(&from_abs) {
        return Err(format!(
            "cannot move a folder into itself: {}",
            from.display()
        ));
    }
    // A case-only rename on a case-insensitive file system names the same entry.
    let same_entry = fs::symlink_metadata(&to_abs).is_ok()
        && dunce::canonicalize(&to_abs).ok() == dunce::canonicalize(&from_abs).ok();
    if fs::symlink_metadata(&to_abs).is_ok() && !same_entry {
        return Err(format!("already exists: {}", to.display()));
    }
    fs::rename(&from_abs, &to_abs).map_err(|e| format!("{}: {e}", from.display()))
}

/// Whether anything is at `path`, hidden files and folders without notes included.
pub fn entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Moves `path` into `.trash/` at the vault root (Obsidian's default); a taken name gets a
/// number. Returns the new location.
pub fn trash_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canon_root = canonical_root(root)?;
    let entry = confined_entry(root, path)?;
    let trash = canon_root.join(".trash");
    if entry == trash || entry.starts_with(&trash) {
        return Err(format!("already in the trash: {}", path.display()));
    }
    let name = plain_name(&entry)?.to_string_lossy().into_owned();
    fs::create_dir_all(&trash).map_err(|e| format!("{}: {e}", trash.display()))?;
    let (stem, ext) = match name.rfind('.').filter(|i| *i > 0) {
        Some(i) => (&name[..i], &name[i..]),
        None => (name.as_str(), ""),
    };
    let mut dest = trash.join(&name);
    let mut n = 1;
    while fs::symlink_metadata(&dest).is_ok() {
        n += 1;
        dest = trash.join(format!("{stem} {n}{ext}"));
    }
    fs::rename(&entry, &dest).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-fileops-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        dunce::canonicalize(p).unwrap()
    }

    #[test]
    fn entry_exists_sees_hidden_and_non_markdown_entries() {
        let root = tmp("exists");
        fs::write(root.join(".hidden"), "").unwrap();
        fs::write(root.join("a.txt"), "").unwrap();
        fs::create_dir(root.join("empty")).unwrap();
        assert!(entry_exists(&root.join(".hidden")));
        assert!(entry_exists(&root.join("a.txt")));
        assert!(entry_exists(&root.join("empty")));
        assert!(!entry_exists(&root.join("missing")));
    }

    #[test]
    fn location_defaults_to_the_root() {
        let root = tmp("loc-default");
        assert_eq!(new_note_location(&root).location, "root");
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(root.join(".obsidian/app.json"), "not json").unwrap();
        assert_eq!(new_note_location(&root).location, "root");
        fs::write(root.join(".obsidian/app.json"), "{}").unwrap();
        assert_eq!(new_note_location(&root).location, "root");
    }

    #[test]
    fn location_reads_folder_and_current() {
        let root = tmp("loc-folder");
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        let app = root.join(".obsidian/app.json");
        fs::write(
            &app,
            r#"{"newFileLocation":"folder","newFileFolderPath":"/Inbox/New/"}"#,
        )
        .unwrap();
        let l = new_note_location(&root);
        assert_eq!(
            (l.location.as_str(), l.folder.as_str()),
            ("folder", "Inbox/New")
        );
        fs::write(
            &app,
            r#"{"newFileLocation":"folder","newFileFolderPath":""}"#,
        )
        .unwrap();
        assert_eq!(new_note_location(&root).location, "root");
        fs::write(&app, r#"{"newFileLocation":"current"}"#).unwrap();
        assert_eq!(new_note_location(&root).location, "current");
    }

    #[test]
    fn daily_notes_config_comes_from_daily_notes_json() {
        let root = tmp("daily");
        assert_eq!(daily_notes_config(&root), DailyNotesConfig::default());
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        let file = root.join(".obsidian/daily-notes.json");
        fs::write(&file, "not json").unwrap();
        assert_eq!(daily_notes_config(&root), DailyNotesConfig::default());
        fs::write(&file, r#"{"folder":"","format":"","template":5}"#).unwrap();
        assert_eq!(daily_notes_config(&root), DailyNotesConfig::default());
        fs::write(
            &file,
            r#"{"folder":"/Journal\\Days/","format":"YYYY/MM/YYYY-MM-DD","template":"Templates/Daily"}"#,
        )
        .unwrap();
        assert_eq!(
            daily_notes_config(&root),
            DailyNotesConfig {
                folder: Some("Journal/Days".into()),
                format: Some("YYYY/MM/YYYY-MM-DD".into()),
                template: Some("Templates/Daily".into()),
            }
        );
    }

    #[test]
    fn template_folder_comes_from_templates_json() {
        let root = tmp("tpl");
        assert_eq!(template_folder(&root), None);
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        let file = root.join(".obsidian/templates.json");
        fs::write(&file, "not json").unwrap();
        assert_eq!(template_folder(&root), None);
        fs::write(&file, r#"{"dateFormat":"YYYY"}"#).unwrap();
        assert_eq!(template_folder(&root), None);
        fs::write(&file, r#"{"folder":""}"#).unwrap();
        assert_eq!(template_folder(&root), None);
        fs::write(
            &file,
            r#"{"folder":"/Meta\\Templates/","dateFormat":"YYYY"}"#,
        )
        .unwrap();
        assert_eq!(template_folder(&root).as_deref(), Some("Meta/Templates"));
    }

    #[test]
    fn create_file_makes_an_empty_note_and_never_overwrites() {
        let root = tmp("cf");
        create_file(&root, &root.join("Untitled.md")).unwrap();
        assert_eq!(fs::read_to_string(root.join("Untitled.md")).unwrap(), "");
        fs::write(root.join("keep.md"), "keep").unwrap();
        assert!(create_file(&root, &root.join("keep.md")).is_err());
        assert_eq!(fs::read_to_string(root.join("keep.md")).unwrap(), "keep");
        assert!(create_file(&root, &root.join("nope").join("x.md")).is_err());
    }

    #[test]
    fn create_refuses_paths_outside_the_root() {
        let base = tmp("outside");
        let root = base.join("vault");
        let other = base.join("vault-evil");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&other).unwrap();
        assert!(create_file(&root, &other.join("x.md")).is_err());
        assert!(create_file(&root, &root.join("..").join("vault-evil").join("x.md")).is_err());
        assert!(create_dir(&root, &other.join("d")).is_err());
        assert!(create_dir(&root, &root.join("..").join("d")).is_err());
        assert!(create_dir(&root, &root).is_err());
        assert!(!other.join("x.md").exists() && !other.join("d").exists());
    }

    #[test]
    fn create_dir_makes_missing_parents() {
        let root = tmp("cd");
        create_dir(&root, &root.join("a").join("b")).unwrap();
        assert!(root.join("a/b").is_dir());
        create_dir(&root, &root.join("a").join("b")).unwrap();
    }

    #[test]
    fn rename_moves_notes_and_folders() {
        let root = tmp("rn");
        fs::write(root.join("a.md"), "a").unwrap();
        fs::create_dir_all(root.join("d")).unwrap();
        fs::write(root.join("d/x.md"), "x").unwrap();
        rename_path(&root, &root.join("a.md"), &root.join("b.md")).unwrap();
        assert!(!root.join("a.md").exists());
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "a");
        rename_path(&root, &root.join("d"), &root.join("e")).unwrap();
        assert!(root.join("e/x.md").is_file());
        rename_path(&root, &root.join("b.md"), &root.join("e").join("b.md")).unwrap();
        assert!(root.join("e/b.md").is_file());
    }

    #[test]
    fn rename_refuses_to_replace_and_to_leave_the_vault() {
        let base = tmp("rn-out");
        let root = base.join("vault");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.md"), "a").unwrap();
        fs::write(root.join("b.md"), "b").unwrap();
        fs::write(base.join("secret.md"), "s").unwrap();
        assert!(rename_path(&root, &root.join("a.md"), &root.join("b.md")).is_err());
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "b");
        assert!(rename_path(&root, &root.join("a.md"), &base.join("a.md")).is_err());
        assert!(rename_path(&root, &base.join("secret.md"), &root.join("s.md")).is_err());
        assert!(rename_path(&root, &root, &base.join("moved")).is_err());
        assert!(rename_path(&root, &root.join("a.md"), &root.join("..").join("a.md")).is_err());
        assert!(base.join("secret.md").exists() && root.join("a.md").exists());
        fs::create_dir_all(root.join("d")).unwrap();
        assert!(rename_path(&root, &root.join("d"), &root.join("d").join("in")).is_err());
        assert!(rename_path(&root, &root.join("missing.md"), &root.join("m.md")).is_err());
    }

    #[test]
    fn rename_allows_a_case_only_change() {
        let root = tmp("rn-case");
        fs::write(root.join("a.md"), "a").unwrap();
        rename_path(&root, &root.join("a.md"), &root.join("A.md")).unwrap();
        let names: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["A.md"]);
    }

    #[test]
    fn trash_moves_into_the_vault_trash_and_numbers_taken_names() {
        let root = tmp("trash");
        fs::write(root.join("a.md"), "1").unwrap();
        let dest = trash_path(&root, &root.join("a.md")).unwrap();
        assert_eq!(dest, root.join(".trash").join("a.md"));
        assert!(!root.join("a.md").exists());
        fs::write(root.join("a.md"), "2").unwrap();
        let dest = trash_path(&root, &root.join("a.md")).unwrap();
        assert_eq!(dest, root.join(".trash").join("a 2.md"));
        assert_eq!(fs::read_to_string(root.join(".trash/a.md")).unwrap(), "1");
        fs::create_dir_all(root.join("d")).unwrap();
        fs::write(root.join("d/x.md"), "x").unwrap();
        trash_path(&root, &root.join("d")).unwrap();
        assert!(root.join(".trash/d/x.md").is_file());
    }

    #[test]
    fn trash_refuses_the_root_the_trash_and_outside_paths() {
        let base = tmp("trash-out");
        let root = base.join("vault");
        fs::create_dir_all(root.join(".trash")).unwrap();
        fs::write(root.join(".trash/t.md"), "t").unwrap();
        fs::write(base.join("secret.md"), "s").unwrap();
        assert!(trash_path(&root, &root).is_err());
        assert!(trash_path(&root, &root.join(".trash")).is_err());
        assert!(trash_path(&root, &root.join(".trash/t.md")).is_err());
        assert!(trash_path(&root, &base.join("secret.md")).is_err());
        assert!(trash_path(&root, &root.join("..").join("secret.md")).is_err());
        assert!(base.join("secret.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_do_not_lead_out_of_the_root() {
        let base = tmp("links");
        let root = base.join("vault");
        let other = base.join("other");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("s.md"), "s").unwrap();
        std::os::unix::fs::symlink(&other, root.join("dir")).unwrap();
        assert!(create_file(&root, &root.join("dir").join("x.md")).is_err());
        assert!(create_dir(&root, &root.join("dir").join("d")).is_err());
        assert!(rename_path(&root, &root.join("dir").join("s.md"), &root.join("s.md")).is_err());
        assert!(trash_path(&root, &root.join("dir").join("s.md")).is_err());
        assert!(other.join("s.md").exists());
        // The link itself may be trashed; the folder it points to stays untouched.
        trash_path(&root, &root.join("dir")).unwrap();
        assert!(other.join("s.md").exists());
    }
}
