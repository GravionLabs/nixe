//! Spike (#60): the whole sync cycle (clone, commit, pull --rebase, push) with libgit2,
//! because iOS has no Git CLI. The token lives in the Keychain, never on disk.

use std::path::Path;

use git2::{
    build::RepoBuilder, Cred, FetchOptions, IndexAddOption, PushOptions, RebaseOptions,
    RemoteCallbacks, Repository, Signature,
};

const KEYCHAIN_SERVICE: &str = "dev.nixe.app.github";
const KEYCHAIN_USER: &str = "token";

fn callbacks(token: Option<&str>) -> RemoteCallbacks<'_> {
    let mut cb = RemoteCallbacks::new();
    if let Some(token) = token {
        // GitHub accepts a personal access token as the password of any user name.
        cb.credentials(move |_, _, _| Cred::userpass_plaintext("x-access-token", token));
    }
    cb
}

pub fn clone(url: &str, dest: &Path, token: Option<&str>) -> Result<(), git2::Error> {
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(token));
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

/// `git pull --rebase`: fetch the branch and replay local commits on top of it.
pub fn pull_rebase(dir: &Path, token: Option<&str>) -> Result<(), git2::Error> {
    let repo = Repository::open(dir)?;
    let branch = branch_name(&repo)?;
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(token));
    repo.find_remote("origin")?
        .fetch(&[&branch], Some(&mut fo), None)?;
    let upstream = repo.reference_to_annotated_commit(&repo.find_reference("FETCH_HEAD")?)?;
    let head = repo.reference_to_annotated_commit(&repo.head()?)?;
    let mut opts = RebaseOptions::new();
    let mut rebase = repo.rebase(Some(&head), Some(&upstream), None, Some(&mut opts))?;
    let sig = repo
        .signature()
        .or_else(|_| Signature::now("Nixe", "nixe@localhost"))?;
    while let Some(op) = rebase.next() {
        op?;
        // A conflicting step stays unresolved: abort so the vault is left untouched.
        if repo.index()?.has_conflicts() {
            rebase.abort()?;
            return Err(git2::Error::from_str("rebase conflict, aborted"));
        }
        rebase.commit(None, &sig, None)?;
    }
    rebase.finish(None)
}

pub fn push(dir: &Path, token: Option<&str>) -> Result<(), git2::Error> {
    let repo = Repository::open(dir)?;
    let branch = branch_name(&repo)?;
    let mut po = PushOptions::new();
    po.remote_callbacks(callbacks(token));
    let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let mut remote = repo.find_remote("origin")?;
    remote.push(&[spec], Some(&mut po))
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
pub fn token_set(token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
pub fn token_get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
pub fn token_set(_: &str) -> Result<(), String> {
    Err("Keychain is only available on Apple platforms".into())
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
pub fn token_get() -> Result<Option<String>, String> {
    Ok(None)
}

fn stored_token() -> Result<Option<String>, String> {
    token_get()
}

fn err(e: git2::Error) -> String {
    e.message().to_owned()
}

#[tauri::command]
pub fn git_token_set(token: String) -> Result<(), String> {
    token_set(&token)
}

#[tauri::command]
pub fn git_token_get() -> Result<bool, String> {
    Ok(token_get()?.is_some())
}

#[tauri::command]
pub async fn git_clone(url: String, dest: String) -> Result<u128, String> {
    let token = stored_token()?;
    tauri::async_runtime::spawn_blocking(move || {
        let start = std::time::Instant::now();
        clone(&url, Path::new(&dest), token.as_deref()).map_err(err)?;
        Ok(start.elapsed().as_millis())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Changes a file in the vault so that `git_commit` has something to commit.
#[tauri::command]
pub fn git_spike_edit(dir: String) -> Result<(), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    std::fs::write(Path::new(&dir).join("nixe-spike.md"), format!("spike {stamp}\n"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit(dir: String, message: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || commit_all(Path::new(&dir), &message).map_err(err))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull_rebase(dir: String) -> Result<(), String> {
    let token = stored_token()?;
    tauri::async_runtime::spawn_blocking(move || {
        pull_rebase(Path::new(&dir), token.as_deref()).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(dir: String) -> Result<(), String> {
    let token = stored_token()?;
    tauri::async_runtime::spawn_blocking(move || {
        push(Path::new(&dir), token.as_deref()).map_err(err)
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

    #[test]
    fn pull_rebase_conflict_aborts_and_errors() {
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
        assert!(pull_rebase(&b, None).is_err());
        assert_eq!(fs::read_to_string(b.join("a.md")).unwrap(), "from b");
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
