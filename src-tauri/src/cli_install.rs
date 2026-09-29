//! "Install Command Line Tool…" (macOS): symlinks the app binary as `nixe` into a
//! directory on the PATH so `nixe file.md` works from any terminal.

use std::io;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const COMMAND_NAME: &str = "nixe";

const ADMIN_DIR: &str = "/usr/local/bin";

/// System locations tried without elevated rights, first usable one wins.
fn system_dirs() -> Vec<PathBuf> {
    vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from(ADMIN_DIR)]
}

fn user_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/bin"))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Shell command creating the link like `install_symlink` does (stale symlinks
/// are replaced, regular files are left alone).
fn admin_shell_command(exe: &Path, dir: &Path) -> String {
    let link = shell_quote(&dir.join(COMMAND_NAME).to_string_lossy());
    format!(
        "mkdir -p {dir} && {{ [ ! -e {link} ] || [ -L {link} ]; }} && ln -sfn {exe} {link}",
        dir = shell_quote(&dir.to_string_lossy()),
        exe = shell_quote(&exe.to_string_lossy()),
    )
}

/// Runs `admin_shell_command` through the macOS administrator password prompt.
fn install_with_admin(exe: &Path, dir: &Path) -> Result<PathBuf, String> {
    let script = admin_shell_command(exe, dir).replace('\\', "\\\\").replace('"', "\\\"");
    let output = Command::new("osascript")
        .args(["-e", &format!("do shell script \"{script}\" with administrator privileges")])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(dir.join(COMMAND_NAME))
    } else {
        Err(format!("{}: {}", dir.display(), String::from_utf8_lossy(&output.stderr).trim()))
    }
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

fn install(app: &AppHandle) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().and_then(std::fs::canonicalize).map_err(|e| e.to_string())?;

    let mut result = install_first_writable(&exe, &system_dirs());
    if result.is_err() {
        let elevate = app
            .dialog()
            .message(format!("Installing into {ADMIN_DIR} needs administrator permission."))
            .title("Nixe")
            .buttons(MessageDialogButtons::OkCancelCustom("Continue".into(), "Use ~/.local/bin".into()))
            .blocking_show();
        if elevate {
            result = install_with_admin(&exe, Path::new(ADMIN_DIR));
        }
    }
    if result.is_err() {
        if let Some(dir) = user_dir() {
            result = install_first_writable(&exe, &[dir]);
        }
    }
    result
}

pub fn run(app: &AppHandle) {
    // The dialogs block, so keep the menu event handler (main thread) free.
    let app = app.clone();
    std::thread::spawn(move || {
        let (kind, message) = match install(&app) {
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
    });
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

    #[test]
    fn admin_command_quotes_paths_and_guards_regular_files() {
        let cmd = admin_shell_command(Path::new("/Apps/It's Nixe/nixe"), Path::new("/usr/local/bin"));
        assert_eq!(
            cmd,
            "mkdir -p '/usr/local/bin' && { [ ! -e '/usr/local/bin/nixe' ] || [ -L '/usr/local/bin/nixe' ]; } \
             && ln -sfn '/Apps/It'\\''s Nixe/nixe' '/usr/local/bin/nixe'"
        );
    }
}
