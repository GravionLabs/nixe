//! Spike (#60): the whole sync cycle (clone, commit, pull --rebase, push) with libgit2,
//! because iOS has no Git CLI. The token lives in the Keychain, never on disk.

use std::path::Path;

use git2::{
    build::RepoBuilder, Cred, FetchOptions, IndexAddOption, PushOptions, RebaseOptions,
    RemoteCallbacks, Repository, Signature,
};

const KEYCHAIN_SERVICE: &str = "dev.nixe.app.github";
const KEYCHAIN_USER: &str = "token";

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

fn callbacks(token: Option<&str>) -> RemoteCallbacks<'_> {
    let mut cb = RemoteCallbacks::new();
    if let Some(token) = token {
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
                return Err(git2::Error::from_str(
                    "authentication failed (token rejected)",
                ));
            }
            offered = true;
            Cred::userpass_plaintext("x-access-token", token)
        });
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

fn vault_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    Ok(vault_path(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
    ))
}

#[tauri::command]
pub async fn git_clone(app: tauri::AppHandle, url: String) -> Result<u128, String> {
    if !is_github_https(&url) {
        return Err("only https://github.com/ urls without credentials are allowed".into());
    }
    let dest = vault_dir(&app)?;
    let token = stored_token()?;
    tauri::async_runtime::spawn_blocking(move || {
        // Spike: a failed or earlier clone leaves the directory behind; start clean
        // so the clone can be repeated and timed.
        let dest_path = dest.as_path();
        if dest_path.is_dir() {
            std::fs::remove_dir_all(dest_path).map_err(|e| e.to_string())?;
        }
        let start = std::time::Instant::now();
        clone(&url, dest_path, token.as_deref()).map_err(err)?;
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
    let token = stored_token()?;
    tauri::async_runtime::spawn_blocking(move || pull_rebase(&dir, token.as_deref()).map_err(err))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(app: tauri::AppHandle) -> Result<(), String> {
    let dir = vault_dir(&app)?;
    let token = stored_token()?;
    tauri::async_runtime::spawn_blocking(move || push(&dir, token.as_deref()).map_err(err))
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
