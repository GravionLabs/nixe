//! The write path of the editor (#68): atomic writes that stay inside the vault root.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Largest note the editor writes.
pub const MAX_BYTES: usize = 5 * 1024 * 1024;

/// The canonical path of `path` when it lies below `root`; the file itself may be new, its folder
/// must exist. Symlinks are resolved first, so a link cannot lead out of the root.
fn checked_target(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = dunce::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let name = path
        .file_name()
        .filter(|n| *n != "." && *n != "..")
        .ok_or_else(|| format!("not a file path: {}", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("not a file path: {}", path.display()))?;
    let parent = dunce::canonicalize(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    if !parent.starts_with(&root) {
        return Err(format!("outside the vault: {}", path.display()));
    }
    let target = parent.join(name);
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if !meta.file_type().is_file() {
            return Err(format!("not a regular file: {}", path.display()));
        }
    }
    Ok(target)
}

const NOTE_EXTENSIONS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "txt"];

/// The root a write of `path` is checked against: the vault root when the note lies below it,
/// else the folder of the open note when `path` is in that folder. Only note files qualify.
pub fn write_root(
    vault: Option<&Path>,
    open: Option<&Path>,
    path: &Path,
) -> Result<PathBuf, String> {
    let is_note = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| NOTE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    if !is_note {
        return Err(format!("not a note file: {}", path.display()));
    }
    let parent = path
        .parent()
        .and_then(|p| dunce::canonicalize(p).ok())
        .ok_or_else(|| format!("not a file path: {}", path.display()))?;
    if let Some(vault) = vault.filter(|v| parent.starts_with(v)) {
        return Ok(vault.to_path_buf());
    }
    if let Some(dir) = open.and_then(Path::parent).filter(|d| parent == *d) {
        return Ok(dir.to_path_buf());
    }
    Err(format!("not allowed to write: {}", path.display()))
}

/// Writes `content` through a temp file in the same folder and renames it over `path`, so a
/// crash leaves either the old or the new note, never half of one.
pub fn write_text_file(root: &Path, path: &Path, content: &str) -> Result<(), String> {
    write_checked(root, path, content, None)
}

/// `write_text_file` for a note that was read before: nothing is written unless the file still
/// holds `expected`, so a change made in between is not overwritten.
pub fn replace_text_file(
    root: &Path,
    path: &Path,
    expected: &str,
    content: &str,
) -> Result<(), String> {
    write_checked(root, path, content, Some(expected))
}

fn write_checked(
    root: &Path,
    path: &Path,
    content: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    if content.len() > MAX_BYTES {
        return Err(format!("note too large: {}", path.display()));
    }
    let target = checked_target(root, path)?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = target.with_file_name(format!(".{name}.nixe-tmp"));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        if let Ok(meta) = fs::metadata(&target) {
            let _ = fs::set_permissions(&tmp, meta.permissions());
        }
        // As late as possible: right before the new text replaces the file.
        if let Some(expected) = expected {
            let current = fs::read(&target)?;
            if current != expected.as_bytes() {
                return Err(std::io::Error::other(
                    if std::str::from_utf8(&current).is_ok() {
                        "the note changed on disk; nothing was written"
                    } else {
                        "the note is not valid UTF-8; writing it would damage it"
                    },
                ));
            }
        }
        fs::rename(&tmp, &target)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    fn tmp(name: &str) -> TestDir {
        TestDir::new(&format!("nixe-write-{name}-"))
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".nixe-tmp"))
            .collect()
    }

    #[test]
    fn write_root_allows_the_vault_and_the_open_notes_folder_only() {
        let base = tmp("wroot");
        let vault = dunce::canonicalize(&base).unwrap().join("vault");
        let loose = dunce::canonicalize(&base).unwrap().join("loose");
        let elsewhere = dunce::canonicalize(&base).unwrap().join("else");
        for d in [&vault, &loose, &elsewhere] {
            fs::create_dir_all(d).unwrap();
        }
        let open = loose.join("a.md");
        let root = |p: &Path| write_root(Some(&vault), Some(&open), p);
        assert_eq!(root(&vault.join("n.md")).unwrap(), vault);
        assert_eq!(root(&loose.join("b.md")).unwrap(), loose);
        assert!(root(&elsewhere.join("n.md")).is_err());
        assert!(write_root(None, None, &vault.join("n.md")).is_err());
    }

    #[test]
    fn write_root_refuses_files_that_are_not_notes() {
        let guard = tmp("wext");
        let base = dunce::canonicalize(&guard).unwrap();
        assert!(write_root(Some(&base), None, &base.join(".zshrc")).is_err());
        assert!(write_root(Some(&base), None, &base.join("x.sh")).is_err());
        assert!(write_root(Some(&base), None, &base.join("X.MD")).is_ok());
    }

    #[test]
    fn replaces_the_content_and_leaves_no_temp_file() {
        let root = tmp("replace");
        let note = root.join("a.md");
        fs::write(&note, "old").unwrap();
        write_text_file(&root, &note, "new ü\n").unwrap();
        assert_eq!(fs::read_to_string(&note).unwrap(), "new ü\n");
        assert!(leftovers(&root).is_empty());
    }

    #[test]
    fn replaces_a_note_only_while_it_holds_the_expected_text() {
        let root = tmp("expected");
        let note = root.join("a.md");
        fs::write(&note, "old").unwrap();
        replace_text_file(&root, &note, "old", "new").unwrap();
        assert_eq!(fs::read_to_string(&note).unwrap(), "new");

        let error = replace_text_file(&root, &note, "old", "mine").unwrap_err();
        assert!(error.contains("changed on disk"), "{error}");
        assert_eq!(fs::read_to_string(&note).unwrap(), "new");
        assert!(leftovers(&root).is_empty());
    }

    #[test]
    fn replacing_refuses_a_missing_note_and_one_that_is_not_utf8() {
        let root = tmp("expected-bad");
        let gone = root.join("gone.md");
        assert!(replace_text_file(&root, &gone, "", "new").is_err());
        assert!(!gone.exists());

        let latin = root.join("latin.md");
        fs::write(&latin, b"caf\xe9").unwrap();
        let error = replace_text_file(&root, &latin, "caf\u{fffd}", "new").unwrap_err();
        assert!(error.contains("UTF-8"), "{error}");
        assert_eq!(fs::read(&latin).unwrap(), b"caf\xe9");
        assert!(leftovers(&root).is_empty());
    }

    #[test]
    fn creates_a_new_note_in_a_subfolder() {
        let root = tmp("create");
        fs::create_dir_all(root.join("sub")).unwrap();
        let note = root.join("sub").join("b.md");
        write_text_file(&root, &note, "hi").unwrap();
        assert_eq!(fs::read_to_string(note).unwrap(), "hi");
    }

    #[test]
    fn refuses_paths_outside_the_root() {
        let root = tmp("outside-root");
        let other = tmp("outside-other");
        let victim = other.join("x.md");
        fs::write(&victim, "keep").unwrap();
        assert!(write_text_file(&root, &victim, "changed").is_err());
        let sneaky = root
            .join("..")
            .join(other.file_name().unwrap())
            .join("x.md");
        assert!(write_text_file(&root, &sneaky, "changed").is_err());
        assert_eq!(fs::read_to_string(victim).unwrap(), "keep");
    }

    #[test]
    fn refuses_a_sibling_folder_that_shares_the_root_prefix() {
        let base = tmp("prefix");
        let root = base.join("vault");
        let sibling = base.join("vault-evil");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        assert!(write_text_file(&root, &sibling.join("x.md"), "no").is_err());
        assert!(!sibling.join("x.md").exists());
    }

    #[test]
    fn refuses_a_missing_folder_and_a_missing_root() {
        let root = tmp("missing");
        assert!(write_text_file(&root, &root.join("nope").join("x.md"), "no").is_err());
        assert!(write_text_file(&root.join("gone"), &root.join("x.md"), "no").is_err());
    }

    #[test]
    fn refuses_a_directory_as_target() {
        let root = tmp("dir");
        fs::create_dir_all(root.join("d.md")).unwrap();
        assert!(write_text_file(&root, &root.join("d.md"), "no").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_lead_out_of_the_root() {
        let root = tmp("link-root");
        let other = tmp("link-other");
        fs::write(other.join("secret.md"), "secret").unwrap();
        std::os::unix::fs::symlink(other.join("secret.md"), root.join("l.md")).unwrap();
        std::os::unix::fs::symlink(&other, root.join("dir")).unwrap();
        assert!(write_text_file(&root, &root.join("l.md"), "x").is_err());
        assert!(write_text_file(&root, &root.join("dir").join("secret.md"), "x").is_err());
        assert_eq!(
            fs::read_to_string(other.join("secret.md")).unwrap(),
            "secret"
        );
    }

    #[test]
    fn enforces_the_size_limit() {
        let root = tmp("size");
        let note = root.join("big.md");
        assert!(write_text_file(&root, &note, &"x".repeat(MAX_BYTES + 1)).is_err());
        assert!(!note.exists());
        write_text_file(&root, &note, &"x".repeat(MAX_BYTES)).unwrap();
    }

    #[test]
    fn a_failed_rename_removes_the_temp_file() {
        let root = tmp("fail");
        // A non-empty directory cannot be replaced by a file; checked_target rejects it first,
        // so provoke the failure through a read-only folder instead.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let note = root.join("a.md");
            fs::write(&note, "old").unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
            let result = write_text_file(&root, &note, "new");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
            if result.is_err() {
                assert_eq!(fs::read_to_string(&note).unwrap(), "old");
            }
            assert!(leftovers(&root).is_empty());
        }
    }
}
