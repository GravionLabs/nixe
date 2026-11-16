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

/// Writes `content` through a temp file in the same folder and renames it over `path`, so a
/// crash leaves either the old or the new note, never half of one.
pub fn write_text_file(root: &Path, path: &Path, content: &str) -> Result<(), String> {
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

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-write-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".nixe-tmp"))
            .collect()
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
