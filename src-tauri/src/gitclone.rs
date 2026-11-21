//! Clone a vault from a GitHub HTTPS url into a new folder (#78). The token comes from the same
//! keychain entry as for sync (#74). A failed or cancelled clone removes the folder it created.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use git2::{build::RepoBuilder, FetchOptions};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::credentials::{KeyringStore, TokenStore};
use crate::gitsync::{callbacks, is_github_https, with_auth};

/// Event with the progress of the running clone (payload: `CloneProgress`).
pub const CLONE_PROGRESS_EVENT: &str = "git-clone-progress";
/// Error text of a clone the user cancelled.
pub const CANCELLED: &str = "cancelled";

/// Objects received so far of the total the remote announced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CloneProgress {
    pub received: usize,
    pub total: usize,
}

/// Name of the folder a url clones into: its last path segment without `.git`.
/// `None` when that is empty or not a plain folder name.
pub fn repo_name(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    let plain = !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    plain.then(|| name.to_owned())
}

/// Clones `url` into `<parent>/<repo name>` and returns that folder. The folder must not exist
/// yet. Any failure, including a cancel (`cancel` becomes true), removes what was created.
pub fn clone_vault(
    url: &str,
    parent: &Path,
    store: &dyn TokenStore,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(CloneProgress),
) -> Result<PathBuf, String> {
    if !parent.is_dir() {
        return Err("the target folder does not exist".into());
    }
    let name = repo_name(url).ok_or("the url has no repository name")?;
    let dest = parent.join(name);
    // Claim the folder atomically: only a folder this call created is ever removed.
    std::fs::create_dir(&dest).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("{} already exists", dest.display())
        } else {
            e.to_string()
        }
    })?;
    let result = with_auth(url, store, |auth| {
        let mut cb = callbacks(auth);
        cb.transfer_progress(|p| {
            progress(CloneProgress {
                received: p.received_objects(),
                total: p.total_objects(),
            });
            !cancel.load(Ordering::SeqCst)
        });
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(cb);
        RepoBuilder::new()
            .fetch_options(fo)
            .clone(url, &dest)
            .map(|_| ())
    });
    match result {
        Ok(()) if !cancel.load(Ordering::SeqCst) => Ok(dest),
        other => {
            // This call created the folder, so everything in it is ours.
            let _ = std::fs::remove_dir_all(&dest);
            match other {
                _ if cancel.load(Ordering::SeqCst) => Err(CANCELLED.into()),
                Err(e) => Err(e),
                Ok(()) => unreachable!(),
            }
        }
    }
}

/// Clones a vault; returns the path of the new folder. A missing or rejected token gives
/// `auth-required:<host>` / `auth-failed:<host>`, a cancel gives `cancelled`.
#[tauri::command]
pub async fn git_clone_vault(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    url: String,
    parent: String,
) -> Result<String, String> {
    let url = url.trim().to_owned();
    if !is_github_https(&url) {
        return Err("only https urls of github.com or a configured host, without credentials, are supported".into());
    }
    let cancel: Arc<AtomicBool> = state.clone_cancel.clone();
    cancel.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = None;
        let mut emit = |p: CloneProgress| {
            // Once per percent, not once per object.
            let step = (p.received * 100).checked_div(p.total);
            if step != last {
                last = step;
                let _ = app.emit(CLONE_PROGRESS_EVENT, p);
            }
        };
        let dest = clone_vault(&url, Path::new(&parent), &KeyringStore, &cancel, &mut emit)?;
        Ok(crate::path_to_string(&dest))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops the running clone; its folder is removed.
#[tauri::command]
pub fn git_clone_cancel(state: State<'_, crate::AppState>) {
    state.clone_cancel.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryStore;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-gitclone-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// A repository with one commit; cloning it by path needs no token.
    fn source(name: &str) -> String {
        let dir = tmp(&format!("{name}-root")).join(format!("{name}-src.git"));
        fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        fs::write(dir.join("a.md"), "one").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new("a.md")).unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("T", "t@t").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        // file:// goes through the pack transport, which reports progress; a bare path does not.
        format!("file://{}", dir.display())
    }

    #[test]
    fn name_comes_from_the_last_segment() {
        for (url, name) in [
            ("https://github.com/a/notes.git", "notes"),
            ("https://github.com/a/notes", "notes"),
            ("https://github.com/a/my-vault.v2/", "my-vault.v2"),
            ("/tmp/x/src.git", "src"),
        ] {
            assert_eq!(repo_name(url).as_deref(), Some(name), "{url}");
        }
        for url in [
            "",
            "https://github.com/a/.git",
            "https://github.com/a/..",
            "a/b c",
        ] {
            assert_eq!(repo_name(url), None, "{url}");
        }
    }

    #[test]
    fn clones_into_a_folder_named_after_the_repository() {
        let url = source("ok");
        let parent = tmp("ok-parent");
        let mut seen = Vec::new();
        let dest = clone_vault(
            &url,
            &parent,
            &MemoryStore::default(),
            &AtomicBool::new(false),
            &mut |p| seen.push(p),
        )
        .unwrap();
        assert_eq!(dest, parent.join("ok-src"));
        assert_eq!(fs::read_to_string(dest.join("a.md")).unwrap(), "one");
        assert!(seen
            .last()
            .is_some_and(|p| p.received == p.total && p.total > 0));
    }

    #[test]
    fn a_cancelled_clone_removes_the_partial_folder() {
        let url = source("cancel");
        let parent = tmp("cancel-parent");
        let cancel = AtomicBool::new(false);
        // Cancel as soon as the first progress arrives.
        let err = clone_vault(&url, &parent, &MemoryStore::default(), &cancel, &mut |_| {
            cancel.store(true, Ordering::SeqCst)
        })
        .unwrap_err();
        assert_eq!(err, CANCELLED);
        assert!(!parent.join("cancel-src").exists());
    }

    #[test]
    fn a_failed_clone_removes_the_partial_folder() {
        let parent = tmp("fail-parent");
        let url = tmp("fail-root")
            .join("missing")
            .to_string_lossy()
            .into_owned();
        let err = clone_vault(
            &url,
            &parent,
            &MemoryStore::default(),
            &AtomicBool::new(false),
            &mut |_| {},
        );
        assert!(err.is_err());
        assert!(!parent.join("missing").exists());
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    }

    #[test]
    fn an_existing_folder_is_never_touched() {
        let url = source("exists");
        let parent = tmp("exists-parent");
        fs::create_dir_all(parent.join("exists-src")).unwrap();
        fs::write(parent.join("exists-src/keep.md"), "mine").unwrap();
        let err = clone_vault(
            &url,
            &parent,
            &MemoryStore::default(),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(err.contains("already exists"));
        assert!(parent.join("exists-src/keep.md").exists());
        assert!(clone_vault(
            &url,
            &parent.join("nope"),
            &MemoryStore::default(),
            &AtomicBool::new(false),
            &mut |_| {}
        )
        .is_err());
    }

    #[test]
    fn a_github_url_without_a_token_asks_for_one_and_leaves_nothing() {
        let parent = tmp("auth-parent");
        let err = clone_vault(
            "https://github.com/a/private.git",
            &parent,
            &MemoryStore::default(),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(err, "auth-required:github.com");
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    }
}
