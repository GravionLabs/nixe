//! Capture from the terminal: `nixe new` and `nixe append` (#103). Both go through the vault
//! rules of the app: the new-note folder of `.obsidian/app.json`, writes confined to the vault
//! root, and atomic replacement of a note (a running window sees it through its file watcher).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::cli::CliError;
use crate::index::{self, read, scan};
use crate::vault::resolve::resolve_link;
use crate::{fileops, write};

/// The folder `--inbox` writes to when the vault sets no new-note folder.
pub const DEFAULT_INBOX: &str = "Inbox";
/// The note of the inbox folder that `append --inbox` appends to.
const INBOX_NOTE: &str = "Inbox.md";

pub struct Request<'a> {
    pub positional: &'a [String],
    pub folder: Option<&'a str>,
    pub open: bool,
    pub inbox: bool,
}

fn failed(e: impl ToString) -> CliError {
    CliError::Failed(e.to_string())
}

fn usage(msg: &str) -> CliError {
    CliError::Usage(msg.to_string())
}

/// Runs `new` or `append` against the vault `root` and prints the path of the note.
pub fn run(
    command: &str,
    req: &Request,
    root: &Path,
    app_data: &Path,
    input: &mut dyn Read,
    out: &mut dyn Write,
) -> Result<(), CliError> {
    let path = if command == "new" {
        new_note(req, root)?
    } else {
        append(req, root, app_data, input)?
    };
    writeln!(out, "{}", path.display()).map_err(failed)?;
    if req.open {
        open_in_viewer(&path)?;
    }
    Ok(())
}

/// The vault-relative folder (no slashes at the ends) a new note goes to by default.
fn default_folder(root: &Path) -> String {
    let setting = fileops::new_note_location(root);
    if setting.location == "folder" {
        setting.folder
    } else {
        String::new()
    }
}

fn inbox_folder(root: &Path) -> String {
    let folder = default_folder(root);
    if folder.is_empty() {
        DEFAULT_INBOX.to_string()
    } else {
        folder
    }
}

/// A note name from the user: no separators or characters that links and file systems reject.
fn note_file_name(title: &str) -> Result<String, CliError> {
    let title = title.trim();
    let stem = title
        .strip_suffix(".md")
        .filter(|s| !s.is_empty())
        .unwrap_or(title);
    if stem.is_empty() || stem == "." || stem == ".." {
        return Err(usage("the note needs a title"));
    }
    if let Some(c) = stem
        .chars()
        .find(|c| c.is_control() || "\\/:*?\"<>|#^[]".contains(*c))
    {
        return Err(CliError::Failed(format!(
            "{title}: the title cannot contain {c:?} (use --folder for a folder)"
        )));
    }
    Ok(format!("{stem}.md"))
}

/// Joins a vault-relative folder to the root; `..` and absolute folders are refused here, the
/// confinement of `fileops` checks symlinks afterwards.
fn folder_path(root: &Path, folder: &str) -> Result<PathBuf, CliError> {
    let rel = folder.replace('\\', "/");
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    let dir = root.join(rel);
    if folder.starts_with('/') || folder.contains(':') || rel.split('/').any(|c| c == "..") {
        return Err(CliError::Failed(format!("{folder}: outside the vault")));
    }
    fileops::create_dir(root, &dir).map_err(failed)?;
    Ok(dir)
}

fn new_note(req: &Request, root: &Path) -> Result<PathBuf, CliError> {
    let [title] = req.positional else {
        return Err(usage("`new` takes exactly one title"));
    };
    let name = note_file_name(title)?;
    let folder = match req.folder {
        Some(f) => f.to_string(),
        None => default_folder(root),
    };
    let dir = folder_path(root, &folder)?;
    let path = dir.join(name);
    fileops::create_file(root, &path).map_err(failed)?;
    Ok(path)
}

fn append(
    req: &Request,
    root: &Path,
    app_data: &Path,
    input: &mut dyn Read,
) -> Result<PathBuf, CliError> {
    let (target, text) = if req.inbox {
        if req.folder.is_some() {
            return Err(usage("--inbox and --folder cannot be combined"));
        }
        let dir = folder_path(root, &inbox_folder(root))?;
        (dir.join(INBOX_NOTE), req.positional.join(" "))
    } else {
        let Some((note, rest)) = req.positional.split_first() else {
            return Err(usage("`append` needs a note (or --inbox)"));
        };
        (existing_or_new(note, req, root, app_data)?, rest.join(" "))
    };
    let text = if text.is_empty() {
        let mut s = String::new();
        input
            .read_to_string(&mut s)
            .map_err(|e| CliError::Failed(format!("stdin: {e}")))?;
        s
    } else {
        text
    };
    if text.is_empty() {
        return Err(usage("nothing to append"));
    }
    let existing = match std::fs::read_to_string(&target) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(CliError::Failed(format!("{}: {e}", target.display()))),
    };
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&text);
    if !content.ends_with('\n') {
        content.push('\n');
    }
    let write_root = write::write_root(Some(root), None, &target).map_err(failed)?;
    write::write_text_file(&write_root, &target, &content).map_err(failed)?;
    Ok(target)
}

/// The absolute path of `note`: the note it names (a vault-relative path with or without `.md`,
/// or a unique name like a wikilink), else where a new note of that name goes.
fn existing_or_new(
    note: &str,
    req: &Request,
    root: &Path,
    app_data: &Path,
) -> Result<PathBuf, CliError> {
    let rel = note.trim_start_matches("./").replace('\\', "/");
    if rel.starts_with('/') || rel.split('/').any(|c| c == "..") {
        return Err(CliError::Failed(format!("{note}: outside the vault")));
    }
    for candidate in [rel.clone(), format!("{rel}.md")] {
        if root.join(&candidate).is_file() {
            return Ok(root.join(candidate));
        }
    }
    if !rel.contains('/') && req.folder.is_none() {
        let mut conn = index::open(&index::index_path(app_data, root))
            .map_err(|e| CliError::Failed(format!("index: {e}")))?;
        scan(&mut conn, root, |_| {}).map_err(|e| CliError::Failed(format!("index: {e}")))?;
        let paths: Vec<String> = read::notes(&conn)
            .map_err(|e| CliError::Failed(format!("index: {e}")))?
            .into_iter()
            .map(|n| n.path)
            .collect();
        if let Some(found) = resolve_link(&rel, &paths) {
            return Ok(root.join(found));
        }
        let stem = rel.strip_suffix(".md").unwrap_or(&rel).to_lowercase();
        let twins = paths.iter().filter(|p| {
            Path::new(p.as_str())
                .file_stem()
                .is_some_and(|s| s.to_string_lossy().to_lowercase() == stem)
        });
        if twins.count() > 1 {
            return Err(CliError::Failed(format!("{note}: the name is ambiguous")));
        }
    }
    // A new note: `a/b` is a vault-relative path, a bare name goes to --folder or the default.
    let (folder, name) = match rel.rsplit_once('/') {
        Some((dir, name)) => (dir.to_string(), name.to_string()),
        None => (
            req.folder
                .map_or_else(|| default_folder(root), str::to_string),
            rel,
        ),
    };
    let name = note_file_name(&name)?;
    Ok(folder_path(root, &folder)?.join(name))
}

/// Opens the note in the viewer: the same executable, started detached with the path.
fn open_in_viewer(path: &Path) -> Result<(), CliError> {
    let exe = std::env::current_exe().map_err(failed)?;
    std::process::Command::new(exe)
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| CliError::Failed(format!("cannot open the viewer: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_become_note_names() {
        assert_eq!(note_file_name(" Idea ").unwrap(), "Idea.md");
        assert_eq!(note_file_name("Idea.md").unwrap(), "Idea.md");
        assert!(note_file_name("").is_err());
        assert!(note_file_name("a/b").is_err());
        assert!(note_file_name("..").is_err());
        assert!(note_file_name("x#y").is_err());
    }
}
