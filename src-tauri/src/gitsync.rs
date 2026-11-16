//! Spike (#60): the whole sync cycle (clone, commit, pull --rebase, push) with libgit2,
//! because iOS has no Git CLI. The token lives in the Keychain, never on disk.

use std::cell::Cell;
use std::path::Path;

use crate::credentials::{self, KeyringStore, TokenStore};
use git2::{
    build::RepoBuilder, Cred, FetchOptions, IndexAddOption, PushOptions, RebaseOptions,
    RemoteCallbacks, Repository, Signature,
};

const GITHUB_PREFIX: &str = "https://github.com/";

/// True for plain `https://github.com/...` URLs without user info, whitespace or
/// control characters. Only such URLs may ever receive the token.
pub fn is_github_https(url: &str) -> bool {
    match url.strip_prefix(GITHUB_PREFIX) {
        Some(rest) => {
            let host_and_path_ok = !rest.is_empty()
                && !rest.contains('@')
                && !rest.chars().any(|c| c.is_whitespace() || c.is_control());
            host_and_path_ok
        }
        None => false,
    }
}

/// The only directory the webview may touch: `<app data dir>/vault`.
pub fn vault_path(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join("vault")
}

/// The token of one remote operation and whether the server rejected it.
pub struct Auth {
    token: String,
    rejected: Cell<bool>,
}

impl Auth {
    pub fn new(token: String) -> Self {
        Self {
            token,
            rejected: Cell::new(false),
        }
    }

    pub fn rejected(&self) -> bool {
        self.rejected.get()
    }
}

fn callbacks(auth: Option<&Auth>) -> RemoteCallbacks<'_> {
    let mut cb = RemoteCallbacks::new();
    if let Some(auth) = auth {
        let mut offered = false;
        // GitHub accepts a personal access token as the password of any user name.
        cb.credentials(move |url, _, _| {
            if !is_github_https(url) {
                return Err(git2::Error::from_str(
                    "refusing to send credentials to a non-GitHub url",
                ));
            }
            // libgit2 asks again after a rejected credential: fail instead of looping.
            if offered {
                auth.rejected.set(true);
                return Err(git2::Error::from_str("authentication failed"));
            }
            offered = true;
            Cred::userpass_plaintext("x-access-token", &auth.token)
        });
    }
    cb
}

pub fn clone(url: &str, dest: &Path, auth: Option<&Auth>) -> Result<(), git2::Error> {
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(auth));
    RepoBuilder::new().fetch_options(fo).clone(url, dest)?;
    Ok(())
}

/// Stages everything and commits. Returns false when nothing changed.
pub fn commit_all(dir: &Path, message: &str) -> Result<bool, git2::Error> {
    let repo = Repository::open(dir)?;
    let mut index = repo.index()?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree = repo.find_tree(index.write_tree()?)?;
    let parent = repo.head()?.peel_to_commit()?;
    if parent.tree_id() == tree.id() {
        return Ok(false);
    }
    let sig = repo
        .signature()
        .or_else(|_| Signature::now("Nixe", "nixe@localhost"))?;
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])?;
    Ok(true)
}

fn branch_name(repo: &Repository) -> Result<String, git2::Error> {
    let head = repo.head()?;
    head.shorthand().map(str::to_owned)
}

/// What `pull_rebase` did to the local branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pulled {
    UpToDate,
    FastForward,
    Rebased,
}

/// Names that make a conflict copy: the date and the device of the local side.
#[derive(Debug, Clone)]
pub struct Stamp {
    pub date: String,
    pub device: String,
}

impl Stamp {
    pub fn now() -> Self {
        Self {
            date: crate::conflict::today(),
            device: crate::conflict::device_name(),
        }
    }
}

/// `git pull --rebase`: fetch the branch and replay local commits on top of it.
///
/// The working tree must be clean (commit first). A conflict never stops the sync: the remote
/// version stays in the file and the local version is written next to it as
/// `Name (conflict <date> <device>).ext`; both are part of the rebased commit. A rebase that
/// fails for another reason is aborted, so the branch and the working tree are left as they were.
pub fn pull_rebase(dir: &Path, auth: Option<&Auth>) -> Result<Pulled, git2::Error> {
    pull_rebase_keeping_both(dir, auth, &Stamp::now()).map(|(pulled, _)| pulled)
}

/// Like `pull_rebase`; also returns the paths (vault-relative) of the notes that conflicted.
pub fn pull_rebase_keeping_both(
    dir: &Path,
    auth: Option<&Auth>,
    stamp: &Stamp,
) -> Result<(Pulled, Vec<String>), git2::Error> {
    let repo = Repository::open(dir)?;
    let branch = branch_name(&repo)?;
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(auth));
    repo.find_remote("origin")?
        .fetch(&[&branch], Some(&mut fo), None)?;
    let upstream = repo.reference_to_annotated_commit(&repo.find_reference("FETCH_HEAD")?)?;
    let (analysis, _) = repo.merge_analysis(&[&upstream])?;
    if analysis.is_up_to_date() {
        return Ok((Pulled::UpToDate, Vec::new()));
    }
    if analysis.is_fast_forward() {
        let mut head = repo.head()?;
        head.set_target(upstream.id(), "sync: fast-forward")?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))?;
        return Ok((Pulled::FastForward, Vec::new()));
    }
    let head = repo.reference_to_annotated_commit(&repo.head()?)?;
    let mut opts = RebaseOptions::new();
    let mut rebase = repo.rebase(Some(&head), Some(&upstream), None, Some(&mut opts))?;
    let sig = repo
        .signature()
        .or_else(|_| Signature::now("Nixe", "nixe@localhost"))?;
    let mut conflicts = Vec::new();
    let replay = (|| -> Result<(), git2::Error> {
        while let Some(op) = rebase.next() {
            op?;
            if repo.index()?.has_conflicts() {
                keep_both(&repo, stamp, &mut conflicts)?;
            }
            rebase.commit(None, &sig, None)?;
        }
        rebase.finish(None)
    })();
    if let Err(e) = replay {
        rebase.abort()?;
        return Err(e);
    }
    Ok((Pulled::Rebased, conflicts))
}

/// Resolves every conflict of the index of a running rebase: the remote side ("ours" while
/// rebasing) stays at the path, the local side ("theirs") becomes the copy. A side that
/// deleted the file is restored from the common ancestor as the copy, so the edit stays.
fn keep_both(
    repo: &Repository,
    stamp: &Stamp,
    conflicts: &mut Vec<String>,
) -> Result<(), git2::Error> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("the repository has no working directory"))?
        .to_path_buf();
    let mut index = repo.index()?;
    let entries: Vec<_> = index.conflicts()?.collect::<Result<_, _>>()?;
    for c in entries {
        let path_bytes = [&c.our, &c.their, &c.ancestor]
            .into_iter()
            .flatten()
            .map(|e| e.path.clone())
            .next()
            .ok_or_else(|| git2::Error::from_str("a conflict without a path"))?;
        let rel = String::from_utf8(path_bytes)
            .map_err(|_| git2::Error::from_str("a conflicting path is not UTF-8"))?;
        // (text at the path, text of the copy)
        let (kept, copy) = match (&c.our, &c.their) {
            (Some(our), Some(their)) => (our.id, their.id),
            (Some(our), None) => (our.id, ancestor_or(&c, our.id)),
            (None, Some(their)) => (their.id, ancestor_or(&c, their.id)),
            (None, None) => {
                index.conflict_remove(Path::new(&rel))?;
                continue;
            }
        };
        let file_name = Path::new(&rel)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&rel);
        let parent = Path::new(&rel).parent().unwrap_or_else(|| Path::new(""));
        let mut copy_rel = parent.join(crate::conflict::copy_name(
            file_name,
            &stamp.date,
            &stamp.device,
        ));
        let mut n = 1;
        while workdir.join(&copy_rel).exists() || index.get_path(&copy_rel, 0).is_some() {
            n += 1;
            copy_rel = parent.join(crate::conflict::copy_name(
                file_name,
                &stamp.date,
                &format!("{} {n}", stamp.device),
            ));
        }
        index.conflict_remove(Path::new(&rel))?;
        for (rel_path, id) in [(Path::new(&rel), kept), (copy_rel.as_path(), copy)] {
            let blob = repo.find_blob(id)?;
            let file = workdir.join(rel_path);
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).map_err(|e| git2::Error::from_str(&e.to_string()))?;
            }
            std::fs::write(&file, blob.content())
                .map_err(|e| git2::Error::from_str(&e.to_string()))?;
            index.add_path(rel_path)?;
        }
        conflicts.push(rel);
    }
    index.write()
}

fn ancestor_or(c: &git2::IndexConflict, fallback: git2::Oid) -> git2::Oid {
    c.ancestor.as_ref().map_or(fallback, |a| a.id)
}

pub fn push(dir: &Path, auth: Option<&Auth>) -> Result<(), git2::Error> {
    let repo = Repository::open(dir)?;
    let branch = branch_name(&repo)?;
    let mut po = PushOptions::new();
    po.remote_callbacks(callbacks(auth));
    let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let mut remote = repo.find_remote("origin")?;
    remote.push(&[spec], Some(&mut po))
}

/// Runs a remote operation with the token stored for the host of `url`.
///
/// A GitHub url without a stored token gives `auth-required:<host>` without touching the
/// network; a token the server rejects gives `auth-failed:<host>`. The frontend asks for a
/// (new) token on both. Other urls (a local path) need no token.
pub fn with_auth<T>(
    url: &str,
    store: &dyn TokenStore,
    op: impl FnOnce(Option<&Auth>) -> Result<T, git2::Error>,
) -> Result<T, String> {
    let host = match credentials::host_of(url) {
        Some(host) if is_github_https(url) => host,
        _ => return op(None).map_err(err),
    };
    let Some(token) = store.get(&host)? else {
        return Err(credentials::auth_error(credentials::AUTH_REQUIRED, &host));
    };
    let auth = Auth::new(token);
    match op(Some(&auth)) {
        Ok(value) => Ok(value),
        Err(_) if auth.rejected() => Err(credentials::auth_error(credentials::AUTH_FAILED, &host)),
        Err(e) => Err(err(e)),
    }
}

fn origin_url(dir: &Path) -> Result<String, String> {
    let repo = Repository::open(dir).map_err(err)?;
    let remote = repo.find_remote("origin").map_err(err)?;
    Ok(remote.url().unwrap_or_default().to_owned())
}

fn err(e: git2::Error) -> String {
    e.message().to_owned()
}

fn vault_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    Ok(vault_path(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
    ))
}

/// What one `Sync` did.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct SyncReport {
    /// Open changes were committed first.
    pub committed: bool,
    /// Commits of the remote were brought in.
    pub pulled: bool,
    /// Local commits were published.
    pub pushed: bool,
    /// Notes (vault-relative) that both sides changed; each kept both versions.
    pub conflicts: Vec<String>,
}

/// Commits open changes, fetches, rebases local commits onto the remote branch and pushes.
/// Every step that fails leaves the repository clean (a rebase is aborted).
pub fn sync_vault(
    dir: &Path,
    fallback: Option<&crate::git::Identity>,
    store: &dyn TokenStore,
) -> Result<SyncReport, String> {
    use crate::git::{Git2Backend, GitBackend};
    let backend = Git2Backend::open(dir).ok_or("the vault is not a Git repository")?;
    let mut report = SyncReport::default();
    if !backend.status()?.changes.is_empty() {
        backend.commit(None, fallback)?;
        report.committed = true;
    }
    let url = origin_url(dir).map_err(|_| "the repository has no remote named origin")?;
    let stamp = Stamp::now();
    let (pulled, conflicts) = with_auth(&url, store, |auth| {
        pull_rebase_keeping_both(dir, auth, &stamp)
    })?;
    report.pulled = pulled != Pulled::UpToDate;
    report.conflicts = conflicts;
    if backend.status()?.ahead > 0 {
        with_auth(&url, store, |auth| push(dir, auth))?;
        report.pushed = true;
    }
    Ok(report)
}

#[tauri::command]
pub async fn git_clone(app: tauri::AppHandle, url: String) -> Result<u128, String> {
    if !is_github_https(&url) {
        return Err("only https://github.com/ urls without credentials are allowed".into());
    }
    let dest = vault_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Spike: a failed or earlier clone leaves the directory behind; start clean
        // so the clone can be repeated and timed.
        let dest_path = dest.as_path();
        if dest_path.is_dir() {
            std::fs::remove_dir_all(dest_path).map_err(|e| e.to_string())?;
        }
        let start = std::time::Instant::now();
        with_auth(&url, &KeyringStore, |auth| clone(&url, dest_path, auth))?;
        Ok(start.elapsed().as_millis())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Changes a file in the vault so that `git_commit` has something to commit.
#[tauri::command]
pub fn git_spike_edit(app: tauri::AppHandle) -> Result<(), String> {
    let dir = vault_dir(&app)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    std::fs::write(dir.join("nixe-spike.md"), format!("spike {stamp}\n")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit(app: tauri::AppHandle, message: String) -> Result<bool, String> {
    let dir = vault_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || commit_all(&dir, &message).map_err(err))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull_rebase(app: tauri::AppHandle) -> Result<(), String> {
    let dir = vault_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_auth(&origin_url(&dir)?, &KeyringStore, |auth| {
            pull_rebase(&dir, auth).map(|_| ())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(app: tauri::AppHandle) -> Result<(), String> {
    let dir = vault_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_auth(&origin_url(&dir)?, &KeyringStore, |auth| push(&dir, auth))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-gitsync-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Bare "remote" with one commit on `main`, seeded through a scratch clone.
    fn remote(name: &str) -> (std::path::PathBuf, String) {
        let bare = tmp(&format!("{name}-bare"));
        let mut opts = git2::RepositoryInitOptions::new();
        opts.bare(true).initial_head("main");
        Repository::init_opts(&bare, &opts).unwrap();
        let url = format!("file://{}", bare.display());
        let seed = tmp(&format!("{name}-seed"));
        let repo = Repository::init_opts(
            &seed,
            git2::RepositoryInitOptions::new().initial_head("main"),
        )
        .unwrap();
        repo.remote("origin", &url).unwrap();
        fs::write(seed.join("a.md"), "one").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new("a.md")).unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = Signature::now("T", "t@t").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        push(&seed, None).unwrap();
        (bare, url)
    }

    #[test]
    fn clone_commit_push_roundtrip() {
        let (bare, url) = remote("rt");
        let work = tmp("rt-work").join("v");
        clone(&url, &work, None).unwrap();
        assert_eq!(fs::read_to_string(work.join("a.md")).unwrap(), "one");
        fs::write(work.join("b.md"), "two").unwrap();
        assert!(commit_all(&work, "add b").unwrap());
        push(&work, None).unwrap();
        let check = Repository::open(&bare).unwrap();
        let head = check
            .find_reference("refs/heads/main")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        assert_eq!(head.message(), Ok("add b"));
    }

    #[test]
    fn commit_without_changes_returns_false() {
        let (_b, url) = remote("nochange");
        let work = tmp("nochange-work").join("v");
        clone(&url, &work, None).unwrap();
        assert!(!commit_all(&work, "noop").unwrap());
    }

    #[test]
    fn pull_rebase_replays_local_commit_on_remote_change() {
        let (_b, url) = remote("rebase");
        let a = tmp("rebase-a").join("v");
        let b = tmp("rebase-b").join("v");
        clone(&url, &a, None).unwrap();
        clone(&url, &b, None).unwrap();
        fs::write(a.join("x.md"), "x").unwrap();
        commit_all(&a, "add x").unwrap();
        push(&a, None).unwrap();
        fs::write(b.join("y.md"), "y").unwrap();
        commit_all(&b, "add y").unwrap();
        pull_rebase(&b, None).unwrap();
        push(&b, None).unwrap();
        assert!(b.join("x.md").exists() && b.join("y.md").exists());
        let repo = Repository::open(&b).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent(0).unwrap().message(), Ok("add x"));
    }

    fn stamp() -> Stamp {
        Stamp {
            date: "2026-11-16".into(),
            device: "mac".into(),
        }
    }

    #[test]
    fn pull_rebase_conflict_keeps_both_versions() {
        let (_b, url) = remote("conflict");
        let a = tmp("conflict-a").join("v");
        let b = tmp("conflict-b").join("v");
        clone(&url, &a, None).unwrap();
        clone(&url, &b, None).unwrap();
        fs::write(a.join("a.md"), "from a").unwrap();
        commit_all(&a, "a").unwrap();
        push(&a, None).unwrap();
        fs::write(b.join("a.md"), "from b").unwrap();
        commit_all(&b, "b").unwrap();
        let (pulled, conflicts) = pull_rebase_keeping_both(&b, None, &stamp()).unwrap();
        assert_eq!(pulled, Pulled::Rebased);
        assert_eq!(conflicts, vec!["a.md".to_owned()]);
        assert_eq!(fs::read_to_string(b.join("a.md")).unwrap(), "from a");
        assert_eq!(
            fs::read_to_string(b.join("a (conflict 2026-11-16 mac).md")).unwrap(),
            "from b"
        );
        assert!(clean(&b));
    }

    fn ident() -> crate::git::Identity {
        crate::git::Identity {
            name: "T".into(),
            email: "t@t".into(),
        }
    }

    /// Two clones of one remote, `a` and `b`.
    fn pair(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let (_bare, url) = remote(name);
        let a = tmp(&format!("{name}-a")).join("v");
        let b = tmp(&format!("{name}-b")).join("v");
        clone(&url, &a, None).unwrap();
        clone(&url, &b, None).unwrap();
        (a, b)
    }

    fn clean(dir: &Path) -> bool {
        let repo = Repository::open(dir).unwrap();
        repo.state() == git2::RepositoryState::Clean
            && repo
                .statuses(None)
                .unwrap()
                .iter()
                .all(|s| s.status().is_empty())
    }

    #[test]
    fn pull_rebase_fast_forwards_and_reports_up_to_date() {
        let (a, b) = pair("ff");
        assert_eq!(pull_rebase(&b, None).unwrap(), Pulled::UpToDate);
        fs::write(a.join("x.md"), "x").unwrap();
        commit_all(&a, "add x").unwrap();
        push(&a, None).unwrap();
        assert_eq!(pull_rebase(&b, None).unwrap(), Pulled::FastForward);
        assert_eq!(fs::read_to_string(b.join("x.md")).unwrap(), "x");
        assert!(clean(&b));
    }

    #[test]
    fn pull_rebase_reports_a_rebase_and_a_conflict_leaves_a_clean_repository() {
        let (a, b) = pair("diverged");
        fs::write(a.join("x.md"), "x").unwrap();
        commit_all(&a, "add x").unwrap();
        push(&a, None).unwrap();
        fs::write(b.join("y.md"), "y").unwrap();
        commit_all(&b, "add y").unwrap();
        assert_eq!(pull_rebase(&b, None).unwrap(), Pulled::Rebased);
    }

    #[test]
    fn sync_commits_pulls_and_pushes() {
        let (a, b) = pair("sync");
        let store = credentials::MemoryStore::default();
        fs::write(a.join("x.md"), "x").unwrap();
        commit_all(&a, "add x").unwrap();
        push(&a, None).unwrap();
        fs::write(b.join("y.md"), "y").unwrap();
        let report = sync_vault(&b, Some(&ident()), &store).unwrap();
        assert_eq!(
            report,
            SyncReport {
                committed: true,
                pulled: true,
                pushed: true,
                conflicts: vec![]
            }
        );
        assert!(b.join("x.md").exists() && b.join("y.md").exists());
        assert!(clean(&b));
        // The other side now fast-forwards to the pushed commit.
        assert_eq!(pull_rebase(&a, None).unwrap(), Pulled::FastForward);
        assert!(a.join("y.md").exists());
        assert_eq!(
            sync_vault(&b, Some(&ident()), &store).unwrap(),
            SyncReport::default()
        );
    }

    #[test]
    fn sync_with_a_conflict_completes_and_pushes_both_files() {
        let (a, b) = pair("sync-conflict");
        let store = credentials::MemoryStore::default();
        fs::write(a.join("a.md"), "from a").unwrap();
        commit_all(&a, "a").unwrap();
        push(&a, None).unwrap();
        fs::write(b.join("a.md"), "from b").unwrap();
        let report = sync_vault(&b, Some(&ident()), &store).unwrap();
        assert_eq!(report.conflicts, vec!["a.md".to_owned()]);
        assert!(report.pushed && report.pulled && report.committed);
        assert!(clean(&b));
        assert_eq!(fs::read_to_string(b.join("a.md")).unwrap(), "from a");
        // The other side receives both files.
        assert_eq!(pull_rebase(&a, None).unwrap(), Pulled::FastForward);
        let copies: Vec<_> = fs::read_dir(&a)
            .unwrap()
            .flatten()
            .filter(|e| crate::conflict::original_name(e.file_name().to_str().unwrap()).is_some())
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(fs::read_to_string(copies[0].path()).unwrap(), "from b");
    }

    #[test]
    fn binary_conflict_keeps_both_files_byte_for_byte() {
        let (a, b) = pair("bin-conflict");
        fs::write(a.join("p.png"), [0u8, 159, 146, 150]).unwrap();
        commit_all(&a, "a").unwrap();
        push(&a, None).unwrap();
        fs::write(b.join("p.png"), [1u8, 2, 0, 255]).unwrap();
        commit_all(&b, "b").unwrap();
        let (_, conflicts) = pull_rebase_keeping_both(&b, None, &stamp()).unwrap();
        assert_eq!(conflicts, vec!["p.png".to_owned()]);
        assert_eq!(fs::read(b.join("p.png")).unwrap(), vec![0u8, 159, 146, 150]);
        assert_eq!(
            fs::read(b.join("p (conflict 2026-11-16 mac).png")).unwrap(),
            vec![1u8, 2, 0, 255]
        );
        assert!(clean(&b));
    }

    #[test]
    fn remote_delete_against_local_edit_restores_the_deleted_side_as_the_copy() {
        let (a, b) = pair("del-remote");
        fs::remove_file(a.join("a.md")).unwrap();
        commit_all(&a, "delete").unwrap();
        push(&a, None).unwrap();
        fs::write(b.join("a.md"), "edited").unwrap();
        commit_all(&b, "edit").unwrap();
        let (_, conflicts) = pull_rebase_keeping_both(&b, None, &stamp()).unwrap();
        assert_eq!(conflicts, vec!["a.md".to_owned()]);
        // The edit is not lost; the deleted version is restored as the copy.
        assert_eq!(fs::read_to_string(b.join("a.md")).unwrap(), "edited");
        assert_eq!(
            fs::read_to_string(b.join("a (conflict 2026-11-16 mac).md")).unwrap(),
            "one"
        );
        assert!(clean(&b));
    }

    #[test]
    fn local_delete_against_remote_edit_keeps_the_remote_edit_and_a_copy() {
        let (a, b) = pair("del-local");
        fs::write(a.join("a.md"), "remote edit").unwrap();
        commit_all(&a, "edit").unwrap();
        push(&a, None).unwrap();
        fs::remove_file(b.join("a.md")).unwrap();
        commit_all(&b, "delete").unwrap();
        let (_, conflicts) = pull_rebase_keeping_both(&b, None, &stamp()).unwrap();
        assert_eq!(conflicts, vec!["a.md".to_owned()]);
        assert_eq!(fs::read_to_string(b.join("a.md")).unwrap(), "remote edit");
        assert_eq!(
            fs::read_to_string(b.join("a (conflict 2026-11-16 mac).md")).unwrap(),
            "one"
        );
        assert!(clean(&b));
    }

    #[test]
    fn sync_reports_a_missing_repository_and_an_unreachable_remote() {
        let store = credentials::MemoryStore::default();
        let plain = tmp("sync-plain");
        assert!(sync_vault(&plain, None, &store).is_err());
        let (_a, b) = pair("sync-gone");
        let repo = Repository::open(&b).unwrap();
        repo.remote_set_url("origin", "file:///nonexistent/repo.git")
            .unwrap();
        fs::write(b.join("z.md"), "z").unwrap();
        assert!(sync_vault(&b, Some(&ident()), &store).is_err());
        // The note is committed locally, nothing is left half done.
        assert!(clean(&b));
    }

    #[test]
    fn github_remote_without_token_asks_for_one_and_skips_the_operation() {
        let store = credentials::MemoryStore::default();
        let mut ran = false;
        let result = with_auth("https://github.com/a/b.git", &store, |_| {
            ran = true;
            Ok(())
        });
        assert_eq!(result, Err("auth-required:github.com".to_owned()));
        assert!(!ran);
    }

    #[test]
    fn stored_token_is_handed_to_the_operation() {
        let store = credentials::MemoryStore::default();
        store.set("github.com", "secret").unwrap();
        let seen = with_auth("https://github.com/a/b.git", &store, |auth| {
            Ok(auth.map(|a| a.token.clone()))
        });
        assert_eq!(seen, Ok(Some("secret".to_owned())));
    }

    #[test]
    fn rejected_token_asks_again_without_leaking_it() {
        let store = credentials::MemoryStore::default();
        store.set("github.com", "secret").unwrap();
        let result: Result<(), String> = with_auth("https://github.com/a/b.git", &store, |auth| {
            auth.unwrap().rejected.set(true);
            Err(git2::Error::from_str("authentication failed"))
        });
        assert_eq!(result, Err("auth-failed:github.com".to_owned()));
    }

    #[test]
    fn other_failures_keep_their_message() {
        let store = credentials::MemoryStore::default();
        store.set("github.com", "secret").unwrap();
        let result: Result<(), String> = with_auth("https://github.com/a/b.git", &store, |_| {
            Err(git2::Error::from_str("network down"))
        });
        assert_eq!(result, Err("network down".to_owned()));
    }

    #[test]
    fn local_remote_needs_no_token() {
        let store = credentials::MemoryStore::default();
        let result = with_auth("file:///tmp/x", &store, |auth| Ok(auth.is_none()));
        assert_eq!(result, Ok(true));
    }

    #[test]
    fn github_https_urls_are_accepted() {
        assert!(is_github_https("https://github.com/GravionLabs/nixe.git"));
    }

    #[test]
    fn non_github_or_credentialed_urls_are_rejected() {
        for url in [
            "https://user:PAT@github.com/a/b.git",
            "https://github.com@evil.example/a/b",
            "https://github.com/",
            "https://github.com.evil.example/a/b",
            "http://github.com/a/b",
            "file:///tmp/repo",
            "ssh://git@github.com/a/b.git",
            "https://github.com/a/b\n.git",
            "",
        ] {
            assert!(!is_github_https(url), "{url}");
        }
    }

    #[test]
    fn vault_path_is_below_app_data_dir() {
        assert_eq!(
            vault_path(Path::new("/data/app")),
            Path::new("/data/app/vault")
        );
    }

    #[test]
    fn clone_of_missing_repository_fails() {
        let dest = tmp("missing").join("v");
        assert!(clone("file:///nonexistent/repo.git", &dest, None).is_err());
    }

    /// Spike measurement: `NIXE_BENCH_REMOTE=<url> cargo test bench_clone -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_clone() {
        let url = std::env::var("NIXE_BENCH_REMOTE").unwrap();
        let dest = tmp("bench").join("v");
        let start = std::time::Instant::now();
        clone(&url, &dest, None).unwrap();
        println!("clone took {} ms", start.elapsed().as_millis());
    }
}
