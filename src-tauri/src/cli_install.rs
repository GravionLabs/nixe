//! "Install Command Line Tool…" (macOS): symlinks the app binary as `nixe` into a
//! directory on the PATH so `nixe file.md` works from any terminal.

use std::io;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const COMMAND_NAME: &str = "nixe";

/// Preferred install locations, first usable one wins.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    dirs
}

/// Creates (or replaces) the `nixe` symlink in `dir`. An existing symlink is
/// replaced, a regular file is never overwritten.
fn install_symlink(exe: &Path, dir: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let link = dir.join(COMMAND_NAME);
    match std::fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::remove_file(&link)?,
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} exists and is not a symlink", link.display()),
            ))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    symlink(exe, &link)?;
    Ok(link)
}

/// Tries each directory in turn and returns the first successful link.
fn install_first_writable(exe: &Path, dirs: &[PathBuf]) -> Result<PathBuf, String> {
    let mut errors = Vec::new();
    for dir in dirs {
        match install_symlink(exe, dir) {
            Ok(link) => return Ok(link),
            Err(e) => errors.push(format!("{}: {e}", dir.display())),
        }
    }
    Err(errors.join("\n"))
}

fn dir_on_path(dir: &Path) -> bool {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|p| p == dir))
        .unwrap_or(false)
}

pub fn run(app: &AppHandle) {
    let result = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|e| e.to_string())
        .and_then(|exe| install_first_writable(&exe, &candidate_dirs()));

    let (kind, message) = match result {
        Ok(link) => {
            let mut text = format!("Installed {}.\nOpen a terminal and run: nixe README.md", link.display());
            if !link.parent().is_some_and(dir_on_path) {
                text.push_str("\n\nNote: that folder is not on your PATH yet. Add it in your shell profile.");
            }
            (MessageDialogKind::Info, text)
        }
        Err(errors) => (
            MessageDialogKind::Error,
            format!("Could not install the command line tool:\n{errors}"),
        ),
    };
    app.dialog().message(message).title("Nixe").kind(kind).show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-cli-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_symlink_and_replaces_stale_one() {
        let root = temp_dir("link");
        let (old, new) = (root.join("old-nixe"), root.join("new-nixe"));
        fs::write(&old, "").unwrap();
        fs::write(&new, "").unwrap();
        let bin = root.join("bin");

        let link = install_symlink(&old, &bin).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), old);
        install_symlink(&new, &bin).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), new);
    }

    #[test]
    fn never_overwrites_a_regular_file() {
        let root = temp_dir("file");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join(COMMAND_NAME), "not ours").unwrap();
        let err = install_symlink(&root.join("exe"), &bin).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(bin.join(COMMAND_NAME)).unwrap(), "not ours");
    }

    #[test]
    fn falls_back_to_next_directory() {
        let root = temp_dir("fallback");
        let blocked = root.join("blocked");
        fs::write(&blocked, "a file, so create_dir_all fails").unwrap();
        let ok = root.join("ok");
        let link = install_first_writable(&root.join("exe"), &[blocked.join("bin"), ok.clone()]).unwrap();
        assert_eq!(link, ok.join(COMMAND_NAME));
    }
}
