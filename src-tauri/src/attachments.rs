//! Attachments of the editor (#81): pasted images and dropped files are copied into the attachment
//! folder of `.nixe/config.json` (the role `attachments`) or `.obsidian/app.json` (`attachmentFolderPath`), all confined to the vault root.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::fileops::{canonical_root, confined_or_root};
use crate::vault::config::{self, Config};

/// `attachmentFolderPath` of `.obsidian/app.json`, with forward slashes.
fn obsidian_setting(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join(".obsidian").join("app.json")).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let value = json.get("attachmentFolderPath")?.as_str()?;
    Some(value.replace('\\', "/"))
}

/// The attachment folder with its source: the role `attachments` of `.nixe/config.json`, else
/// `attachmentFolderPath` of `.obsidian/app.json` as written there.
pub fn attachment_setting(root: &Path) -> Option<(String, &'static str)> {
    if let Some(folder) = Config::load(root).attachment_folder() {
        return Some((folder, config::SOURCE));
    }
    let value = obsidian_setting(root)?.trim().to_string();
    (!value.is_empty()).then_some((value, ".obsidian/app.json"))
}

/// The vault-relative folder (forward slashes, empty for the vault root) that holds the attachments
/// of a note in `note_dir` (vault-relative, empty for the root).
///
/// `attachmentFolderPath` is `/` or missing for the vault root, `./` for the folder of the note,
/// `./sub` for a subfolder of it, and any other value for a fixed folder.
pub fn attachment_folder(root: &Path, note_dir: &str) -> String {
    if let Some(folder) = Config::load(root).attachment_folder() {
        return folder;
    }
    let setting = obsidian_setting(root).unwrap_or_default();
    let relative = setting == "." || setting.starts_with("./");
    let tail = setting.trim_start_matches('.').trim_matches('/');
    let tail = if relative {
        tail
    } else {
        setting.trim_matches('/')
    };
    if !relative {
        return tail.to_string();
    }
    match (note_dir.trim_matches('/'), tail) {
        ("", t) => t.to_string(),
        (n, "") => n.to_string(),
        (n, t) => format!("{n}/{t}"),
    }
}

/// `name` when `taken(name)` is false, else `stem 1.ext`, `stem 2.ext`, …
pub fn unique_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    };
    (1..)
        .map(|n| format!("{stem} {n}{ext}"))
        .find(|candidate| !taken(candidate))
        .expect("an unbounded range")
}

/// The last segment of `name`, refusing empty names and `.` / `..`.
fn file_name(name: &str) -> Result<String, String> {
    let last = name.replace('\\', "/");
    let last = last.rsplit('/').next().unwrap_or("").trim();
    if last.is_empty() || last == "." || last == ".." {
        return Err(format!("not a file name: {name}"));
    }
    Ok(last.to_string())
}

fn relative_to(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(canonical_root(root)?)
        .map_err(|_| format!("outside the vault: {}", path.display()))
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// The folder for the attachments of `note`, created when missing.
fn target_folder(root: &Path, note: &Path) -> Result<PathBuf, String> {
    let canon_root = canonical_root(root)?;
    let note_parent = note
        .parent()
        .ok_or_else(|| format!("outside the vault: {}", note.display()))?;
    let note_dir = relative_to(root, &confined_or_root(root, note_parent)?)?;
    let folder = attachment_folder(root, &note_dir);
    let dir = if folder.is_empty() {
        canon_root
    } else {
        let wanted = canon_root.join(&folder);
        let dir = confined_or_root(root, &wanted)?;
        fs::create_dir_all(&dir).map_err(|e| format!("{folder}: {e}"))?;
        dunce::canonicalize(&dir).map_err(|e| format!("{folder}: {e}"))?
    };
    if !dir.starts_with(canonical_root(root)?) {
        return Err(format!("outside the vault: {folder}"));
    }
    Ok(dir)
}

/// Writes `bytes` as `name` (numbered when taken) into the attachment folder of `note`; returns the
/// vault-relative path of the new file.
pub fn save_bytes(root: &Path, note: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    store(root, note, name, |file| file.write_all(bytes))
}

/// Brings `source` into the vault: a file that already lies in the vault is not copied and its
/// vault-relative path is returned; any other file is copied into the attachment folder of `note`.
pub fn import_file(root: &Path, note: &Path, source: &Path) -> Result<String, String> {
    let canon_root = canonical_root(root)?;
    let canon = dunce::canonicalize(source).map_err(|e| format!("{}: {e}", source.display()))?;
    if !canon.is_file() {
        return Err(format!("not a file: {}", source.display()));
    }
    if canon.starts_with(&canon_root) {
        return relative_to(root, &canon);
    }
    let name = file_name(&source.to_string_lossy())?;
    store(root, note, &name, |file| {
        let mut from = fs::File::open(&canon)?;
        std::io::copy(&mut from, file).map(|_| ())
    })
}

fn store(
    root: &Path,
    note: &Path,
    name: &str,
    write: impl Fn(&mut fs::File) -> std::io::Result<()>,
) -> Result<String, String> {
    let name = file_name(name)?;
    let dir = target_folder(root, note)?;
    let mut candidate = unique_name(&name, |n| dir.join(n).exists());
    loop {
        let target = dir.join(&candidate);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                if let Err(e) = write(&mut file) {
                    drop(file);
                    let _ = fs::remove_file(&target);
                    return Err(format!("{candidate}: {e}"));
                }
                return relative_to(root, &target);
            }
            // Someone created the name since the check: take the next number.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                candidate = unique_name(&name, |n| dir.join(n).exists() || n == candidate);
            }
            Err(e) => return Err(format!("{candidate}: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-attach-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        dunce::canonicalize(p).unwrap()
    }

    fn setting(root: &Path, json: &str) {
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(root.join(".obsidian/app.json"), json).unwrap();
    }

    #[test]
    fn the_folder_defaults_to_the_vault_root() {
        let root = tmp("default");
        assert_eq!(attachment_folder(&root, "Notes"), "");
        setting(&root, "not json");
        assert_eq!(attachment_folder(&root, "Notes"), "");
        setting(&root, r#"{"attachmentFolderPath":"/"}"#);
        assert_eq!(attachment_folder(&root, "Notes"), "");
        setting(&root, r#"{"attachmentFolderPath":""}"#);
        assert_eq!(attachment_folder(&root, "Notes"), "");
    }

    #[test]
    fn a_fixed_folder_ignores_the_note() {
        let root = tmp("fixed");
        setting(&root, r#"{"attachmentFolderPath":"/Assets/Img/"}"#);
        assert_eq!(attachment_folder(&root, "Notes/Deep"), "Assets/Img");
        setting(&root, r#"{"attachmentFolderPath":"Assets"}"#);
        assert_eq!(attachment_folder(&root, ""), "Assets");
    }

    #[test]
    fn the_same_folder_and_subfolders_follow_the_note() {
        let root = tmp("relative");
        setting(&root, r#"{"attachmentFolderPath":"./"}"#);
        assert_eq!(attachment_folder(&root, "Notes/Deep"), "Notes/Deep");
        assert_eq!(attachment_folder(&root, ""), "");
        setting(&root, r#"{"attachmentFolderPath":"./attachments"}"#);
        assert_eq!(
            attachment_folder(&root, "Notes/Deep"),
            "Notes/Deep/attachments"
        );
        assert_eq!(attachment_folder(&root, ""), "attachments");
        setting(&root, r#"{"attachmentFolderPath":".\\files\\img"}"#);
        assert_eq!(attachment_folder(&root, "A"), "A/files/img");
    }

    #[test]
    fn a_taken_name_gets_a_number() {
        let taken = |names: &'static [&'static str]| move |n: &str| names.contains(&n);
        assert_eq!(unique_name("a.png", taken(&[])), "a.png");
        assert_eq!(unique_name("a.png", taken(&["a.png"])), "a 1.png");
        assert_eq!(
            unique_name("a.png", taken(&["a.png", "a 1.png"])),
            "a 2.png"
        );
        assert_eq!(unique_name("a", taken(&["a"])), "a 1");
        assert_eq!(unique_name(".env", taken(&[".env"])), ".env 1");
    }

    #[test]
    fn pasted_bytes_land_in_the_folder_and_never_overwrite() {
        let root = tmp("save");
        setting(&root, r#"{"attachmentFolderPath":"Assets"}"#);
        fs::create_dir_all(root.join("Notes")).unwrap();
        let note = root.join("Notes/n.md");
        fs::write(&note, "").unwrap();
        let first = save_bytes(&root, &note, "Pasted image 1.png", b"one").unwrap();
        let second = save_bytes(&root, &note, "Pasted image 1.png", b"two").unwrap();
        assert_eq!(first, "Assets/Pasted image 1.png");
        assert_eq!(second, "Assets/Pasted image 1 1.png");
        assert_eq!(fs::read(root.join(&first)).unwrap(), b"one");
        assert_eq!(fs::read(root.join(&second)).unwrap(), b"two");
    }

    #[test]
    fn a_note_subfolder_is_created_next_to_the_note() {
        let root = tmp("sub");
        setting(&root, r#"{"attachmentFolderPath":"./att"}"#);
        fs::create_dir_all(root.join("Notes")).unwrap();
        let note = root.join("Notes/n.md");
        let path = save_bytes(&root, &note, "x.png", b"x").unwrap();
        assert_eq!(path, "Notes/att/x.png");
        assert!(root.join(&path).is_file());
    }

    #[test]
    fn a_name_cannot_leave_the_folder() {
        let root = tmp("name");
        let note = root.join("n.md");
        assert!(save_bytes(&root, &note, "..", b"x").is_err());
        assert!(save_bytes(&root, &note, "", b"x").is_err());
        let path = save_bytes(&root, &note, "../../evil.png", b"x").unwrap();
        assert_eq!(path, "evil.png");
    }

    #[test]
    fn a_fixed_folder_cannot_lead_out_of_the_vault() {
        let root = tmp("escape");
        setting(&root, r#"{"attachmentFolderPath":"../outside"}"#);
        let note = root.join("n.md");
        assert!(save_bytes(&root, &note, "x.png", b"x").is_err());
    }

    #[test]
    fn a_dropped_file_is_copied_with_its_name() {
        let root = tmp("drop-in");
        let other = tmp("drop-out");
        fs::write(other.join("doc.pdf"), b"pdf").unwrap();
        let note = root.join("n.md");
        let first = import_file(&root, &note, &other.join("doc.pdf")).unwrap();
        let second = import_file(&root, &note, &other.join("doc.pdf")).unwrap();
        assert_eq!(first, "doc.pdf");
        assert_eq!(second, "doc 1.pdf");
        assert_eq!(fs::read(root.join(&first)).unwrap(), b"pdf");
    }

    #[test]
    fn a_dropped_file_inside_the_vault_is_not_copied() {
        let root = tmp("drop-vault");
        setting(&root, r#"{"attachmentFolderPath":"Assets"}"#);
        fs::create_dir_all(root.join("Pics")).unwrap();
        fs::write(root.join("Pics/a.png"), b"a").unwrap();
        let note = root.join("n.md");
        let path = import_file(&root, &note, &root.join("Pics/a.png")).unwrap();
        assert_eq!(path, "Pics/a.png");
        assert!(!root.join("Assets").exists());
    }

    #[test]
    fn a_folder_cannot_be_dropped() {
        let root = tmp("drop-dir");
        let other = tmp("drop-dir-out");
        assert!(import_file(&root, &root.join("n.md"), &other).is_err());
    }
}
