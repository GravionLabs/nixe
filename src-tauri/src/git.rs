//! Git status and commit of the vault (#73). `GitBackend` is the seam the commands use;
//! `Git2Backend` implements it with libgit2 (no Git CLI needed, also on iOS).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{IndexAddOption, Repository, Signature, Status, StatusOptions};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitChange {
    /// Path relative to the vault root.
    pub path: String,
    pub kind: ChangeKind,
    /// True for a new file Git does not track yet (not staged); only `status` sets it.
    pub untracked: bool,
    /// The other half of a rename or move: on the deleted note the new path, on the added note
    /// the old one. Only `status` sets it, for a note whose text did not change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pair: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitStatus {
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    pub changes: Vec<GitChange>,
    pub ahead: usize,
    pub behind: usize,
    /// Whether the repository has a remote to sync with.
    #[serde(rename = "hasRemote")]
    pub has_remote: bool,
}

/// Author used when the Git config has no `user.name` / `user.email`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

pub trait GitBackend {
    fn status(&self) -> Result<GitStatus, String>;
    /// Stages all changes and commits; returns the id of the commit.
    /// `message` defaults to `vault backup: <timestamp>`.
    fn commit(&self, message: Option<&str>, fallback: Option<&Identity>) -> Result<String, String>;
    /// Commits only the given paths (vault-relative; a changed, new or deleted note); every other
    /// change stays in the working tree. Anything staged before is left out.
    fn commit_paths(
        &self,
        paths: &[String],
        message: Option<&str>,
        fallback: Option<&Identity>,
    ) -> Result<String, String>;
}

pub struct Git2Backend {
    repo: Repository,
}

impl Git2Backend {
    /// `None` when the folder itself is not a Git repository (a repository further up
    /// does not count: the vault would show the changes of unrelated files).
    pub fn open(root: &Path) -> Option<Self> {
        Repository::open(root).ok().map(|repo| Self { repo })
    }
}

fn e(err: git2::Error) -> String {
    err.message().to_owned()
}

fn kind_of(s: Status) -> Option<ChangeKind> {
    if s.intersects(Status::WT_DELETED | Status::INDEX_DELETED) {
        Some(ChangeKind::Deleted)
    } else if s.intersects(Status::WT_NEW | Status::INDEX_NEW) {
        Some(ChangeKind::Added)
    } else if s.intersects(
        Status::WT_MODIFIED
            | Status::INDEX_MODIFIED
            | Status::WT_RENAMED
            | Status::INDEX_RENAMED
            | Status::WT_TYPECHANGE
            | Status::INDEX_TYPECHANGE,
    ) {
        Some(ChangeKind::Modified)
    } else {
        None
    }
}

/// `YYYY-MM-DD HH:MM:SS` in UTC.
pub fn format_timestamp(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

pub fn default_message() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format!("vault backup: {}", format_timestamp(secs))
}

impl GitBackend for Git2Backend {
    fn status(&self) -> Result<GitStatus, String> {
        let repo = &self.repo;
        let head = repo.head().ok();
        let branch: Option<String> = match &head {
            Some(h) if h.is_branch() => h.shorthand().ok().map(str::to_owned),
            Some(_) => None,
            // An unborn branch has no HEAD reference to resolve yet.
            None => repo.find_reference("HEAD").ok().and_then(|r| {
                r.symbolic_target()
                    .ok()
                    .flatten()
                    .and_then(|t| t.strip_prefix("refs/heads/"))
                    .map(str::to_owned)
            }),
        };

        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false);
        let statuses = repo.statuses(Some(&mut opts)).map_err(e)?;
        let mut changes: Vec<GitChange> = statuses
            .iter()
            .filter_map(|s| {
                let status = s.status();
                Some(GitChange {
                    path: s.path().ok()?.to_owned(),
                    kind: kind_of(status)?,
                    untracked: status.contains(Status::WT_NEW)
                        && !status.contains(Status::INDEX_NEW),
                    pair: None,
                })
            })
            .collect();
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        self.pair_renames(&mut changes);

        let (mut ahead, mut behind) = (0, 0);
        if let (Some(head), Some(name)) = (&head, &branch) {
            if let (Some(local), Ok(upstream)) = (
                head.target(),
                repo.find_branch(name, git2::BranchType::Local)
                    .and_then(|b| b.upstream())
                    .map(|u| u.get().target()),
            ) {
                if let Some(upstream) = upstream {
                    (ahead, behind) = repo.graph_ahead_behind(local, upstream).map_err(e)?;
                }
            }
        }
        let has_remote = repo.remotes().map(|r| !r.is_empty()).unwrap_or(false);
        Ok(GitStatus {
            branch,
            changes,
            ahead,
            behind,
            has_remote,
        })
    }

    fn commit(&self, message: Option<&str>, fallback: Option<&Identity>) -> Result<String, String> {
        let repo = &self.repo;
        let mut index = repo.index().map_err(e)?;
        index
            .add_all(["*"], IndexAddOption::DEFAULT, None)
            .map_err(e)?;
        // `add_all` does not stage deletions.
        index.update_all(["*"], None).map_err(e)?;
        index.write().map_err(e)?;
        self.commit_index(&mut index, message, fallback)
    }

    fn commit_paths(
        &self,
        paths: &[String],
        message: Option<&str>,
        fallback: Option<&Identity>,
    ) -> Result<String, String> {
        let repo = &self.repo;
        let mut index = repo.index().map_err(e)?;
        // Start from the saved state, so nothing staged earlier slips in.
        match repo.head().ok().and_then(|h| h.peel_to_tree().ok()) {
            Some(tree) => index.read_tree(&tree).map_err(e)?,
            None => index.clear().map_err(e)?,
        }
        let workdir = repo
            .workdir()
            .ok_or("the repository has no working directory")?;
        for path in paths {
            let rel = Path::new(path);
            if rel.is_absolute()
                || rel
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err(format!("not a path of the vault: {path}"));
            }
            if workdir.join(rel).is_file() {
                index.add_path(rel).map_err(e)?;
            } else if index.get_path(rel, 0).is_some() {
                index.remove_path(rel).map_err(e)?;
            }
        }
        index.write().map_err(e)?;
        self.commit_index(&mut index, message, fallback)
    }
}

impl Git2Backend {
    /// Writes the tree of the index as a commit on HEAD.
    fn commit_index(
        &self,
        index: &mut git2::Index,
        message: Option<&str>,
        fallback: Option<&Identity>,
    ) -> Result<String, String> {
        let repo = &self.repo;
        let tree = repo.find_tree(index.write_tree().map_err(e)?).map_err(e)?;
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        if let Some(p) = &parent {
            if p.tree_id() == tree.id() {
                return Err("nothing to commit".into());
            }
        } else if tree.is_empty() {
            return Err("nothing to commit".into());
        }
        let sig = match repo.signature() {
            Ok(sig) => sig,
            Err(_) => {
                let id = fallback
                    .filter(|i| !i.name.trim().is_empty() && !i.email.trim().is_empty())
                    .ok_or("no author: set user.name and user.email in the Git config or in the settings")?;
                Signature::now(id.name.trim(), id.email.trim()).map_err(e)?
            }
        };
        let message = message
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(default_message);
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
            .map_err(e)?;
        Ok(oid.to_string())
    }

    /// Marks a deleted and an added note with the same text as the two halves of a rename.
    fn pair_renames(&self, changes: &mut [GitChange]) {
        let repo = &self.repo;
        let (Some(workdir), Some(tree)) = (
            repo.workdir(),
            repo.head().ok().and_then(|h| h.peel_to_tree().ok()),
        ) else {
            return;
        };
        let mut gone: Vec<(usize, git2::Oid)> = Vec::new();
        for (i, c) in changes.iter().enumerate() {
            if c.kind != ChangeKind::Deleted {
                continue;
            }
            if let Ok(entry) = tree.get_path(Path::new(&c.path)) {
                gone.push((i, entry.id()));
            }
        }
        if gone.is_empty() {
            return;
        }
        for i in 0..changes.len() {
            if changes[i].kind != ChangeKind::Added {
                continue;
            }
            let Ok(id) =
                git2::Oid::hash_file(git2::ObjectType::Blob, workdir.join(&changes[i].path))
            else {
                continue;
            };
            let Some(pos) = gone
                .iter()
                .position(|(j, old)| *old == id && changes[*j].pair.is_none())
            else {
                continue;
            };
            let (j, _) = gone.remove(pos);
            changes[i].pair = Some(changes[j].path.clone());
            changes[j].pair = Some(changes[i].path.clone());
        }
    }
}

/// `None` when the vault is not a Git repository: the UI then shows nothing of Git.
pub fn vault_status(root: &Path) -> Result<Option<GitStatus>, String> {
    Git2Backend::open(root).map(|b| b.status()).transpose()
}

/// The `.gitignore` entries the vault needs, each with a path that must be ignored (#443).
const GITIGNORE_ENTRIES: [(&str, &str); 3] = [
    (".nixe/local/", ".nixe/local/x"),
    (".*.nixe-tmp", ".x.md.nixe-tmp"),
    (".trash/", ".trash/x"),
];

/// The file in `.nixe/local/` that marks the hint as dismissed for this vault.
const GITIGNORE_DISMISSED: &str = ".nixe/local/gitignore-hint-dismissed";

/// The standard entries the vault's Git ignore rules do not cover; `None` when the vault is no
/// Git repository. Asks Git itself (like `git check-ignore`), so a pattern in any form counts.
/// Empty when the hint was dismissed.
pub fn gitignore_missing(root: &Path) -> Result<Option<Vec<String>>, String> {
    let Some(backend) = Git2Backend::open(root) else {
        return Ok(None);
    };
    if root.join(GITIGNORE_DISMISSED).is_file() {
        return Ok(Some(Vec::new()));
    }
    let mut missing = Vec::new();
    for (entry, probe) in GITIGNORE_ENTRIES {
        if !backend.repo.is_path_ignored(probe).map_err(e)? {
            missing.push(entry.to_string());
        }
    }
    Ok(Some(missing))
}

/// Appends the missing entries under a `# Nixe` comment to `.gitignore`; existing lines stay as
/// they are. Returns the entries that were added.
pub fn gitignore_add(root: &Path) -> Result<Vec<String>, String> {
    let missing = {
        let Some(backend) = Git2Backend::open(root) else {
            return Err("the vault is not a Git repository".to_string());
        };
        let mut missing = Vec::new();
        for (entry, probe) in GITIGNORE_ENTRIES {
            if !backend.repo.is_path_ignored(probe).map_err(e)? {
                missing.push(entry.to_string());
            }
        }
        missing
    };
    if missing.is_empty() {
        return Ok(missing);
    }
    append_gitignore(root, &missing)?;
    Ok(missing)
}

/// Appends `entries` under a `# Nixe` comment to the `.gitignore` of the vault; the lines that
/// are there stay as they are.
fn append_gitignore(root: &Path, entries: &[String]) -> Result<(), String> {
    use std::io::Write;
    let path = root.join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut block = String::new();
    if !existing.is_empty() {
        if !existing.ends_with('\n') {
            block.push('\n');
        }
        block.push('\n');
    }
    block.push_str("# Nixe\n");
    for entry in entries {
        block.push_str(entry);
        block.push('\n');
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(block.as_bytes()))
        .map_err(|err| format!(".gitignore: {err}"))
}

/// Makes sure the vault-relative folder `dir` (with a trailing `/`, like `Links/.archive/`) is
/// ignored: appends it to `.gitignore` when Git does not ignore it yet (without a repository: when
/// no line of the file names it). Returns whether a line was added. Never rewrites the file.
pub fn gitignore_ensure(root: &Path, dir: &str) -> Result<bool, String> {
    let dir = format!("{}/", dir.trim_matches('/'));
    let covered = match Git2Backend::open(root) {
        Some(backend) => backend.repo.is_path_ignored(format!("{dir}x")).map_err(e)?,
        None => std::fs::read_to_string(root.join(".gitignore"))
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().trim_start_matches('/'))
            .any(|l| l == dir || l == dir.trim_end_matches('/')),
    };
    if covered {
        return Ok(false);
    }
    append_gitignore(root, &[dir])?;
    Ok(true)
}

/// Hides the `.gitignore` hint for this vault; the choice lives in `.nixe/local/`.
pub fn gitignore_dismiss(root: &Path) -> Result<(), String> {
    let path = root.join(GITIGNORE_DISMISSED);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    std::fs::write(&path, "").map_err(|err| err.to_string())
}

pub fn vault_commit(
    root: &Path,
    message: Option<&str>,
    fallback: Option<&Identity>,
) -> Result<String, String> {
    Git2Backend::open(root)
        .ok_or_else(|| "the vault is not a Git repository".to_string())?
        .commit(message, fallback)
}

/// Commits only the notes at `paths`; the other changes stay open (#326).
pub fn vault_commit_paths(
    root: &Path,
    paths: &[String],
    message: Option<&str>,
    fallback: Option<&Identity>,
) -> Result<String, String> {
    Git2Backend::open(root)
        .ok_or_else(|| "the vault is not a Git repository".to_string())?
        .commit_paths(paths, message, fallback)
}

/// Trailer of a commit that one structural operation wrote (#241): `Nixe-Operation: rename`.
const OPERATION_TRAILER: &str = "Nixe-Operation";
/// Trailer of the commit that undid an operation: `Nixe-Undo: <id of the undone commit>`.
const UNDO_TRAILER: &str = "Nixe-Undo";
/// How far back the last operation is looked for.
const OPERATION_WALK: usize = 200;

fn trailer<'a>(message: &'a str, key: &str) -> Option<&'a str> {
    message
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix(key)?.strip_prefix(": "))
        .map(str::trim)
}

/// A commit that one operation of the vault wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    /// `rename`, `move`, `delete`, `merge` or `extract`.
    pub kind: String,
    /// First line of the message, e.g. `rename: A -> B, links in 9 notes`.
    pub message: String,
}

fn operation_of(commit: &git2::Commit) -> Option<Operation> {
    let message = commit.message().ok()?;
    Some(Operation {
        id: commit.id().to_string(),
        kind: trailer(message, OPERATION_TRAILER)?.to_owned(),
        message: commit.summary().ok().flatten().unwrap_or("").to_owned(),
    })
}

/// Commits the open changes so that the next commit holds nothing but one operation. Nothing
/// to commit is fine. `false` when the vault is no Git repository.
pub fn checkpoint(root: &Path, reason: &str, fallback: Option<&Identity>) -> Result<bool, String> {
    let Some(backend) = Git2Backend::open(root) else {
        return Ok(false);
    };
    match backend.commit(Some(&format!("checkpoint before {reason}")), fallback) {
        Ok(_) => {}
        Err(m) if m == "nothing to commit" => {}
        Err(m) => return Err(format!("could not commit before the {reason}: {m}")),
    }
    Ok(true)
}

/// Commits the changes of one operation: `summary` is the first line, the trailer marks it.
/// Nothing to commit is fine.
pub fn commit_operation(
    root: &Path,
    kind: &str,
    summary: &str,
    fallback: Option<&Identity>,
) -> Result<(), String> {
    let message = format!("{summary}\n\n{OPERATION_TRAILER}: {kind}\n");
    match vault_commit(root, Some(&message), fallback) {
        Ok(_) => Ok(()),
        Err(m) if m == "nothing to commit" => Ok(()),
        Err(m) => Err(m),
    }
}

/// The newest operation commit that is not undone yet; `None` without Git or operations.
pub fn last_operation(root: &Path) -> Result<Option<Operation>, String> {
    let Some(backend) = Git2Backend::open(root) else {
        return Ok(None);
    };
    let repo = &backend.repo;
    if repo.head().is_err() {
        return Ok(None);
    }
    let mut walk = repo.revwalk().map_err(e)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(e)?;
    walk.push_head().map_err(e)?;
    let mut undone = std::collections::HashSet::new();
    for oid in walk.take(OPERATION_WALK) {
        let commit = repo.find_commit(oid.map_err(e)?).map_err(e)?;
        if let Some(id) = commit.message().ok().and_then(|m| trailer(m, UNDO_TRAILER)) {
            undone.insert(id.to_owned());
        }
        if let Some(op) = operation_of(&commit) {
            if !undone.contains(&op.id) {
                return Ok(Some(op));
            }
        }
    }
    Ok(None)
}

/// Reverts the last operation as a new commit, also when edits came after it. Open changes
/// are committed first. A revert that conflicts is refused and changes nothing.
pub fn undo_operation(root: &Path, fallback: Option<&Identity>) -> Result<Operation, String> {
    let backend =
        Git2Backend::open(root).ok_or_else(|| "the vault is not a Git repository".to_string())?;
    let op = last_operation(root)?.ok_or_else(|| "no vault operation to undo".to_string())?;
    let repo = &backend.repo;
    let target = repo
        .find_commit(git2::Oid::from_str(&op.id).map_err(e)?)
        .map_err(e)?;
    let refused = || {
        format!(
            "cannot undo \"{}\": later changes conflict with it, nothing was changed",
            op.message
        )
    };
    let conflicts = |head: &git2::Commit| -> Result<git2::Index, String> {
        let index = repo.revert_commit(&target, head, 0, None).map_err(e)?;
        if index.has_conflicts() {
            return Err(refused());
        }
        Ok(index)
    };
    // Refuse before the open changes are committed.
    let head = repo.head().and_then(|h| h.peel_to_commit()).map_err(e)?;
    conflicts(&head)?;
    checkpoint(root, "undo", fallback)?;
    let head = repo.head().and_then(|h| h.peel_to_commit()).map_err(e)?;
    let mut index = conflicts(&head)?;
    let tree = repo
        .find_tree(index.write_tree_to(repo).map_err(e)?)
        .map_err(e)?;
    let sig = match repo.signature() {
        Ok(sig) => sig,
        Err(_) => {
            let id = fallback
                .filter(|i| !i.name.trim().is_empty() && !i.email.trim().is_empty())
                .ok_or(
                    "no author: set user.name and user.email in the Git config or in the settings",
                )?;
            Signature::now(id.name.trim(), id.email.trim()).map_err(e)?
        }
    };
    let message = format!("undo: {}\n\n{UNDO_TRAILER}: {}\n", op.message, op.id);
    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&head])
        .map_err(e)?;
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    repo.checkout_head(Some(&mut checkout)).map_err(e)?;
    Ok(op)
}

/// Commits only `rel` (its file as it is now, or its removal) and nothing else of the open
/// changes. `false` when that changes nothing in the tree.
fn commit_path(
    repo: &Repository,
    rel: &Path,
    message: &str,
    fallback: Option<&Identity>,
) -> Result<bool, String> {
    let workdir = repo.workdir().ok_or("the vault has no working folder")?;
    let mut index = repo.index().map_err(e)?;
    if workdir.join(rel).is_file() {
        index.add_path(rel).map_err(e)?;
    } else {
        // A path that is not in the index is already gone.
        let _ = index.remove_path(rel);
    }
    index.write().map_err(e)?;
    let tree = repo.find_tree(index.write_tree().map_err(e)?).map_err(e)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if parent.as_ref().is_some_and(|p| p.tree_id() == tree.id()) {
        return Ok(false);
    }
    let sig = match repo.signature() {
        Ok(sig) => sig,
        Err(_) => {
            let id = fallback
                .filter(|i| !i.name.trim().is_empty() && !i.email.trim().is_empty())
                .ok_or(
                    "no author: set user.name and user.email in the Git config or in the settings",
                )?;
            Signature::now(id.name.trim(), id.email.trim()).map_err(e)?
        }
    };
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(e)?;
    Ok(true)
}

/// Takes the changes of one note back (#319): a changed or deleted note gets its saved version
/// again, a new note is removed. Only this note is committed: first as it is now, then the
/// discard as one operation commit, so Undo brings the discarded state back. The other open
/// changes stay open. A rename shows as a deleted old path and a new path; each is discarded on
/// its own.
pub fn discard_note(
    root: &Path,
    path: &str,
    fallback: Option<&Identity>,
) -> Result<Operation, String> {
    let rel = Path::new(path);
    let plain = !path.is_empty()
        && rel
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        && rel.components().next().map(|c| c.as_os_str()) != Some(std::ffi::OsStr::new(".git"));
    if !plain {
        return Err(format!("not a note of the vault: {path}"));
    }
    let backend =
        Git2Backend::open(root).ok_or_else(|| "the vault is not a Git repository".to_string())?;
    let repo = &backend.repo;
    let status = repo.status_file(rel).map_err(e)?;
    if kind_of(status).is_none() {
        return Err(format!("{path} has no changes to discard"));
    }
    // The saved version, read before anything is committed.
    let saved: Option<Vec<u8>> = match repo.head().and_then(|h| h.peel_to_tree()) {
        Ok(tree) => match tree.get_path(rel) {
            Ok(entry) => Some(repo.find_blob(entry.id()).map_err(e)?.content().to_vec()),
            Err(_) => None,
        },
        Err(_) => None,
    };
    commit_path(repo, rel, "checkpoint before discard", fallback)?;
    let file = root.join(rel);
    let summary = match &saved {
        Some(bytes) => {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
            }
            std::fs::write(&file, bytes).map_err(|err| err.to_string())?;
            format!("discard changes: {path}")
        }
        None => {
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(err.to_string()),
            }
            // Folders that only held this note go with it (remove_dir fails on a used one).
            let mut dir = file.parent();
            while let Some(d) = dir.filter(|d| *d != root) {
                if std::fs::remove_dir(d).is_err() {
                    break;
                }
                dir = d.parent();
            }
            format!("discard new note: {path}")
        }
    };
    let message = format!("{summary}\n\n{OPERATION_TRAILER}: discard\n");
    commit_path(repo, rel, &message, fallback)?;
    last_operation(root)?.ok_or_else(|| "the discard was not recorded".to_string())
}

/// Puts an older version of a note back (#324): the open state of the note is committed first
/// (the current version stays in the history), then the content of `revision` is written and
/// committed as one operation commit, so Undo brings the replaced version back. `from` is the
/// path of the note in `revision` (it differs after a rename). Other open changes stay open.
pub fn restore_note(
    root: &Path,
    path: &str,
    from: &str,
    revision: &str,
    fallback: Option<&Identity>,
) -> Result<Operation, String> {
    let plain = |p: &str| {
        let rel = Path::new(p);
        !p.is_empty()
            && rel
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
            && rel.components().next().map(|c| c.as_os_str()) != Some(std::ffi::OsStr::new(".git"))
    };
    if !plain(path) || !plain(from) {
        return Err(format!("not a note of the vault: {path}"));
    }
    let rel = Path::new(path);
    let backend =
        Git2Backend::open(root).ok_or_else(|| "the vault is not a Git repository".to_string())?;
    let repo = &backend.repo;
    let tree = repo
        .revparse_single(revision)
        .and_then(|o| o.peel_to_commit())
        .and_then(|c| c.tree())
        .map_err(e)?;
    let entry = tree
        .get_path(Path::new(from))
        .map_err(|_| format!("{from} does not exist in {revision}"))?;
    let bytes = repo.find_blob(entry.id()).map_err(e)?.content().to_vec();
    commit_path(repo, rel, "checkpoint before restore", fallback)?;
    let file = root.join(rel);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    std::fs::write(&file, bytes).map_err(|err| err.to_string())?;
    let short: String = revision.chars().take(7).collect();
    let message = format!("restore: {path} to {short}\n\n{OPERATION_TRAILER}: restore\n");
    if !commit_path(repo, rel, &message, fallback)? {
        return Err("the note already has this version".to_string());
    }
    last_operation(root)?.ok_or_else(|| "the restore was not recorded".to_string())
}

/// One commit that touched a note (#105).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub author: String,
    /// Seconds since the epoch.
    pub time: i64,
    /// First line of the message.
    pub message: String,
    /// The path of the note in this commit (differs from the open path after a rename).
    pub path: String,
    /// First parent; `None` for the commit that created the note's repository.
    pub parent: Option<String>,
    /// The path of the note in the parent (the old name when this commit renamed it).
    pub parent_path: String,
    /// The kind of vault operation that wrote this commit (#241); `None` for other commits.
    pub operation: Option<String>,
}

fn blob_id(tree: &git2::Tree, path: &str) -> Option<git2::Oid> {
    tree.get_path(Path::new(path)).ok().map(|e| e.id())
}

/// The commits that touched `path`, newest first, following renames. Skips `offset` matches
/// and returns at most `limit`. The walk starts at HEAD every time; a commit costs two tree
/// lookups, so a few thousand commits stay well under a second.
pub fn note_history(
    root: &Path,
    path: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<HistoryEntry>, String> {
    let Some(backend) = Git2Backend::open(root) else {
        return Ok(vec![]);
    };
    let repo = &backend.repo;
    if repo.head().is_err() {
        return Ok(vec![]);
    }
    let mut walk = repo.revwalk().map_err(e)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(e)?;
    walk.push_head().map_err(e)?;
    let mut current = path.to_owned();
    let mut out = Vec::new();
    let mut seen = 0usize;
    for oid in walk {
        let commit = repo.find_commit(oid.map_err(e)?).map_err(e)?;
        let tree = commit.tree().map_err(e)?;
        let Some(here) = blob_id(&tree, &current) else {
            continue;
        };
        let parents: Vec<git2::Commit> = commit.parents().collect();
        let in_parents: Vec<Option<git2::Oid>> = parents
            .iter()
            .map(|p| p.tree().ok().and_then(|t| blob_id(&t, &current)))
            .collect();
        // Untouched: some parent has the same content (also covers a merge that took one side).
        if in_parents.contains(&Some(here)) {
            continue;
        }
        let mut parent_path = current.clone();
        let mut renamed_from = None;
        if let Some(first) = parents.first() {
            if in_parents[0].is_none() {
                // Added here, or renamed here: look for the old name.
                let ptree = first.tree().map_err(e)?;
                let mut diff = repo
                    .diff_tree_to_tree(Some(&ptree), Some(&tree), None)
                    .map_err(e)?;
                let mut find = git2::DiffFindOptions::new();
                find.renames(true);
                diff.find_similar(Some(&mut find)).map_err(e)?;
                for d in diff.deltas() {
                    if d.status() == git2::Delta::Renamed
                        && d.new_file().path().and_then(Path::to_str) == Some(current.as_str())
                    {
                        renamed_from = d
                            .old_file()
                            .path()
                            .and_then(Path::to_str)
                            .map(str::to_owned);
                    }
                }
                if let Some(old) = &renamed_from {
                    parent_path = old.clone();
                }
            }
        }
        if seen >= offset {
            out.push(HistoryEntry {
                id: commit.id().to_string(),
                author: commit.author().name().unwrap_or("").to_owned(),
                time: commit.time().seconds(),
                message: commit.summary().ok().flatten().unwrap_or("").to_owned(),
                path: current.clone(),
                parent: parents.first().map(|p| p.id().to_string()),
                parent_path,
                operation: operation_of(&commit).map(|o| o.kind),
            });
            if out.len() >= limit {
                break;
            }
        }
        seen += 1;
        if let Some(old) = renamed_from {
            current = old;
        }
    }
    Ok(out)
}

/// The text of a note at `rev` (a commit id; `HEAD` works too), or the file on disk for
/// `None`. A note that does not exist there reads as an empty text.
pub fn note_version(root: &Path, path: &str, rev: Option<&str>) -> Result<String, String> {
    let Some(rev) = rev else {
        return Ok(std::fs::read_to_string(root.join(path)).unwrap_or_default());
    };
    let backend =
        Git2Backend::open(root).ok_or_else(|| "the vault is not a Git repository".to_string())?;
    let repo = &backend.repo;
    let tree = repo
        .revparse_single(rev)
        .and_then(|o| o.peel_to_commit())
        .and_then(|c| c.tree())
        .map_err(e)?;
    let Some(entry) = tree.get_path(Path::new(path)).ok() else {
        return Ok(String::new());
    };
    let blob = repo.find_blob(entry.id()).map_err(e)?;
    Ok(String::from_utf8_lossy(blob.content()).into_owned())
}

/// A note that a recent commit deleted (#106).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedNote {
    /// Vault-relative path of the deleted note.
    pub path: String,
    /// The commit that deleted it.
    pub id: String,
    /// The parent of that commit, which still has the note: restore reads it from there.
    pub parent: String,
    pub author: String,
    /// Seconds since the epoch.
    pub time: i64,
    pub message: String,
}

/// The Markdown notes that the last `commits` commits (first-parent, newest first) deleted
/// and that do not exist in HEAD now. A note deleted twice is listed once, at its newest deletion.
pub fn deleted_notes(root: &Path, commits: usize) -> Result<Vec<DeletedNote>, String> {
    let Some(backend) = Git2Backend::open(root) else {
        return Ok(vec![]);
    };
    let repo = &backend.repo;
    if repo.head().is_err() {
        return Ok(vec![]);
    }
    let head_tree = repo.head().and_then(|h| h.peel_to_tree()).map_err(e)?;
    let mut walk = repo.revwalk().map_err(e)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(e)?;
    walk.push_head().map_err(e)?;
    let mut out: Vec<DeletedNote> = Vec::new();
    for oid in walk.take(commits) {
        let commit = repo.find_commit(oid.map_err(e)?).map_err(e)?;
        let Some(parent) = commit.parents().next() else {
            continue;
        };
        let diff = repo
            .diff_tree_to_tree(
                Some(&parent.tree().map_err(e)?),
                Some(&commit.tree().map_err(e)?),
                None,
            )
            .map_err(e)?;
        for d in diff.deltas() {
            if d.status() != git2::Delta::Deleted {
                continue;
            }
            let Some(path) = d.old_file().path().and_then(Path::to_str) else {
                continue;
            };
            let is_note = path.to_lowercase().ends_with(".md");
            if !is_note || blob_id(&head_tree, path).is_some() || out.iter().any(|n| n.path == path)
            {
                continue;
            }
            out.push(DeletedNote {
                path: path.to_owned(),
                id: commit.id().to_string(),
                parent: parent.id().to_string(),
                author: commit.author().name().unwrap_or("").to_owned(),
                time: commit.time().seconds(),
                message: commit.summary().ok().flatten().unwrap_or("").to_owned(),
            });
        }
    }
    Ok(out)
}

/// A note that one of the latest commits added or changed, with that commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentNote {
    /// Vault-relative path of the note.
    pub path: String,
    pub id: String,
    pub author: String,
    /// Seconds since the epoch.
    pub time: i64,
    pub message: String,
}

/// The Markdown notes that the last `commits` commits (newest first) added or changed and that
/// exist in HEAD, each once at its newest change, at most `limit` of them.
pub fn recent_notes(root: &Path, commits: usize, limit: usize) -> Result<Vec<RecentNote>, String> {
    let Some(backend) = Git2Backend::open(root) else {
        return Ok(vec![]);
    };
    let repo = &backend.repo;
    if repo.head().is_err() {
        return Ok(vec![]);
    }
    let mut walk = repo.revwalk().map_err(e)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(e)?;
    walk.push_head().map_err(e)?;
    let mut out: Vec<RecentNote> = Vec::new();
    for oid in walk.take(commits) {
        let commit = repo.find_commit(oid.map_err(e)?).map_err(e)?;
        let parent_tree = match commit.parents().next() {
            Some(p) => Some(p.tree().map_err(e)?),
            None => None,
        };
        let diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit.tree().map_err(e)?), None)
            .map_err(e)?;
        for d in diff.deltas() {
            if d.status() == git2::Delta::Deleted {
                continue;
            }
            let Some(path) = d.new_file().path().and_then(Path::to_str) else {
                continue;
            };
            if !path.to_lowercase().ends_with(".md") || out.iter().any(|n| n.path == path) {
                continue;
            }
            out.push(RecentNote {
                path: path.to_owned(),
                id: commit.id().to_string(),
                author: commit.author().name().unwrap_or("").to_owned(),
                time: commit.time().seconds(),
                message: commit.summary().ok().flatten().unwrap_or("").to_owned(),
            });
        }
    }
    // A note a later commit deleted is not in HEAD; the trash lists it.
    let head_tree = repo.head().and_then(|h| h.peel_to_tree()).map_err(e)?;
    out.retain(|n| blob_id(&head_tree, &n.path).is_some());
    out.truncate(limit);
    Ok(out)
}

/// The Markdown notes that differ between the commit `from` and `to` (HEAD when `None`):
/// added, modified and deleted ones, sorted by path (#107). Renames show as a delete and an add.
pub fn changes_between(
    root: &Path,
    from: &str,
    to: Option<&str>,
) -> Result<Vec<GitChange>, String> {
    let backend =
        Git2Backend::open(root).ok_or_else(|| "the vault is not a Git repository".to_string())?;
    notes_changed(&backend.repo, from, to.unwrap_or("HEAD"))
}

pub(crate) fn notes_changed(
    repo: &git2::Repository,
    from: &str,
    to: &str,
) -> Result<Vec<GitChange>, String> {
    let tree_of = |rev: &str| {
        repo.revparse_single(rev)
            .and_then(|o| o.peel_to_commit())
            .and_then(|c| c.tree())
            .map_err(e)
    };
    let old = tree_of(from)?;
    let new = tree_of(to)?;
    let diff = repo
        .diff_tree_to_tree(Some(&old), Some(&new), None)
        .map_err(e)?;
    let mut out: Vec<GitChange> = Vec::new();
    for d in diff.deltas() {
        let kind = match d.status() {
            git2::Delta::Added => ChangeKind::Added,
            git2::Delta::Deleted => ChangeKind::Deleted,
            git2::Delta::Modified | git2::Delta::Typechange => ChangeKind::Modified,
            _ => continue,
        };
        let file = if kind == ChangeKind::Deleted {
            d.old_file()
        } else {
            d.new_file()
        };
        let Some(path) = file.path().and_then(Path::to_str) else {
            continue;
        };
        if path.to_lowercase().ends_with(".md") {
            out.push(GitChange {
                path: path.to_owned(),
                kind,
                untracked: false,
                pair: None,
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// The newest commit (id) reachable from HEAD that is at or before `secs` (seconds since the
/// epoch); `None` when the history starts later (#107).
pub fn rev_at(root: &Path, secs: i64) -> Result<Option<String>, String> {
    let Some(backend) = Git2Backend::open(root) else {
        return Ok(None);
    };
    let repo = &backend.repo;
    if repo.head().is_err() {
        return Ok(None);
    }
    let mut walk = repo.revwalk().map_err(e)?;
    walk.set_sorting(git2::Sort::TIME).map_err(e)?;
    walk.push_head().map_err(e)?;
    for oid in walk {
        let commit = repo.find_commit(oid.map_err(e)?).map_err(e)?;
        if commit.time().seconds() <= secs {
            return Ok(Some(commit.id().to_string()));
        }
    }
    Ok(None)
}

/// One commit of the vault log, for the version picker (#321).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCommit {
    pub id: String,
    pub author: String,
    /// Seconds since the epoch.
    pub time: i64,
    /// First line of the message.
    pub message: String,
}

/// The commits reachable from HEAD, newest first; skips `offset` and returns at most `limit`.
pub fn vault_log(root: &Path, offset: usize, limit: usize) -> Result<Vec<VaultCommit>, String> {
    let Some(backend) = Git2Backend::open(root) else {
        return Ok(vec![]);
    };
    let repo = &backend.repo;
    if repo.head().is_err() {
        return Ok(vec![]);
    }
    let mut walk = repo.revwalk().map_err(e)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(e)?;
    walk.push_head().map_err(e)?;
    let mut out = Vec::new();
    for oid in walk.skip(offset).take(limit) {
        let commit = repo.find_commit(oid.map_err(e)?).map_err(e)?;
        out.push(VaultCommit {
            id: commit.id().to_string(),
            author: commit.author().name().unwrap_or("").to_owned(),
            time: commit.time().seconds(),
            message: commit.summary().ok().flatten().unwrap_or("").to_owned(),
        });
    }
    Ok(out)
}

/// A branch that waits for review (#108): ahead of the working branch and named with the prefix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBranch {
    /// Branch name without the remote (`claude/tidy-inbox`).
    pub name: String,
    /// The tip commit; every other command takes it as the revision.
    pub tip: String,
    /// The branch exists only on a remote (`origin`), not as a local branch.
    pub remote: bool,
    /// Author of the newest commit.
    pub author: String,
    /// Seconds since the epoch, of the newest commit.
    pub time: i64,
    /// First lines of the commit messages the branch is ahead by, newest first.
    pub messages: Vec<String>,
    /// How many commits the branch is ahead of the working branch.
    pub ahead: usize,
    /// How many notes differ from the merge base.
    pub notes: usize,
}

/// The changes of a review branch against the merge base with HEAD.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChanges {
    /// The merge base: the "before" side of every note.
    pub base: String,
    pub changes: Vec<GitChange>,
}

/// Local and remote branches named with `prefix` that are ahead of HEAD, newest first. A branch
/// that exists locally and on a remote is listed once, with the tip that contains the other (else the newer). An empty prefix lists
/// nothing; so does a vault without a commit.
pub fn review_branches(root: &Path, prefix: &str) -> Result<Vec<ReviewBranch>, String> {
    let Some(backend) = Git2Backend::open(root) else {
        return Ok(vec![]);
    };
    let repo = &backend.repo;
    let Some(head) = repo.head().ok().and_then(|h| h.target()) else {
        return Ok(vec![]);
    };
    if prefix.is_empty() {
        return Ok(vec![]);
    }
    let mut found: Vec<ReviewBranch> = Vec::new();
    for item in repo.branches(None).map_err(e)? {
        let (branch, kind) = item.map_err(e)?;
        let Some(full) = branch.name().map_err(e)? else {
            continue;
        };
        let remote = kind == git2::BranchType::Remote;
        // `origin/claude/x` -> `claude/x`; `origin/HEAD` has no target.
        let name = if remote {
            full.split_once('/').map_or(full, |(_, rest)| rest)
        } else {
            full
        };
        if !name.starts_with(prefix) {
            continue;
        }
        let Some(tip) = branch.get().resolve().ok().and_then(|r| r.target()) else {
            continue;
        };
        let (ahead, _) = repo.graph_ahead_behind(tip, head).map_err(e)?;
        if ahead == 0 {
            continue;
        }
        let commit = repo.find_commit(tip).map_err(e)?;
        let mut walk = repo.revwalk().map_err(e)?;
        walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
            .map_err(e)?;
        walk.push(tip).map_err(e)?;
        walk.hide(head).map_err(e)?;
        let mut messages = Vec::new();
        for oid in walk {
            let c = repo.find_commit(oid.map_err(e)?).map_err(e)?;
            messages.push(c.summary().ok().flatten().unwrap_or("").to_owned());
        }
        // A branch without common history (orphan) cannot be reviewed; it must not hide the others.
        let Ok(base) = repo.merge_base(head, tip) else {
            continue;
        };
        let Ok(changed) = notes_changed(repo, &base.to_string(), &tip.to_string()) else {
            continue;
        };
        let notes = changed.len();
        let entry = ReviewBranch {
            name: name.to_owned(),
            tip: tip.to_string(),
            remote,
            author: commit.author().name().unwrap_or("").to_owned(),
            time: commit.time().seconds(),
            messages,
            ahead,
            notes,
        };
        match found.iter_mut().find(|b| b.name == entry.name) {
            Some(existing) => {
                // Local and remote differ: the one that contains the other, else the newer.
                let old = git2::Oid::from_str(&existing.tip).map_err(e)?;
                let newer = if repo.graph_descendant_of(tip, old).map_err(e)? {
                    true
                } else if repo.graph_descendant_of(old, tip).map_err(e)? {
                    false
                } else {
                    entry.time > existing.time
                };
                if newer {
                    *existing = entry;
                }
            }
            None => found.push(entry),
        }
    }
    found.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| a.name.cmp(&b.name)));
    Ok(found)
}

/// The notes a branch (any revision) changed relative to its merge base with HEAD (#108).
pub fn review_changes(root: &Path, rev: &str) -> Result<ReviewChanges, String> {
    let backend =
        Git2Backend::open(root).ok_or_else(|| "the vault is not a Git repository".to_string())?;
    let repo = &backend.repo;
    let head = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .ok_or_else(|| "the vault has no commit yet".to_string())?;
    let tip = repo
        .revparse_single(rev)
        .and_then(|o| o.peel_to_commit())
        .map_err(e)?
        .id();
    let base = repo.merge_base(head, tip).map_err(e)?.to_string();
    let changes = notes_changed(repo, &base, &tip.to_string())?;
    Ok(ReviewChanges { base, changes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;
    use std::fs;

    fn temp(name: &str) -> TestDir {
        TestDir::new(&format!("nixe-git-{name}-"))
    }

    /// A repository with an identity in its own config and one commit of `a.md`.
    fn repo_with_commit(name: &str) -> (TestDir, Git2Backend) {
        let dir = temp(name);
        let repo = Repository::init(&dir).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Config Author").unwrap();
        cfg.set_str("user.email", "config@example.com").unwrap();
        fs::write(dir.join("a.md"), "a").unwrap();
        let backend = Git2Backend { repo };
        backend.commit(Some("init"), None).unwrap();
        (dir, backend)
    }

    fn commit_file(dir: &Path, backend: &Git2Backend, name: &str, text: &str, msg: &str) {
        fs::write(dir.join(name), text).unwrap();
        backend.commit(Some(msg), None).unwrap();
    }

    /// Commits `files` on a new branch `name` cut from HEAD, then returns to the working branch.
    fn commit_on_branch(dir: &Path, backend: &Git2Backend, name: &str, files: &[(&str, &str)]) {
        let repo = &backend.repo;
        let work = repo.head().unwrap().name().unwrap().to_owned();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch(name, &head, true).unwrap();
        repo.set_head(&format!("refs/heads/{name}")).unwrap();
        for (file, text) in files {
            fs::write(dir.join(file), text).unwrap();
            backend.commit(Some(&format!("edit {file}")), None).unwrap();
        }
        repo.set_head(&work).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    }

    #[test]
    fn review_branches_lists_prefixed_branches_that_are_ahead() {
        let (dir, backend) = repo_with_commit("review");
        commit_on_branch(
            &dir,
            &backend,
            "claude/tidy",
            &[("a.md", "tidy"), ("new.md", "n"), ("img.png", "x")],
        );
        commit_on_branch(&dir, &backend, "feature/other", &[("o.md", "o")]);
        // A branch with nothing new is not waiting.
        let head = backend.repo.head().unwrap().peel_to_commit().unwrap();
        backend.repo.branch("claude/empty", &head, false).unwrap();
        // The working branch moves on: the merge base is older than HEAD.
        commit_file(&dir, &backend, "main.md", "m", "main work");
        let list = review_branches(&dir, "claude/").unwrap();
        assert_eq!(list.len(), 1);
        let b = &list[0];
        assert_eq!(b.name, "claude/tidy");
        assert!(!b.remote);
        assert_eq!(b.author, "Config Author");
        assert_eq!(b.ahead, 3);
        assert_eq!(b.notes, 2, "a.md and new.md; the image is no note");
        assert_eq!(b.messages, vec!["edit img.png", "edit new.md", "edit a.md"]);
        assert_eq!(
            b.tip,
            backend
                .repo
                .find_branch("claude/tidy", git2::BranchType::Local)
                .unwrap()
                .get()
                .target()
                .unwrap()
                .to_string()
        );
        // The prefix is configurable; an empty one lists nothing.
        let other = review_branches(&dir, "feature/").unwrap();
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].name, "feature/other");
        assert!(review_branches(&dir, "").unwrap().is_empty());
        assert!(review_branches(&dir, "nothing/").unwrap().is_empty());
    }

    #[test]
    fn review_branches_lists_a_remote_branch_once_with_the_newer_tip() {
        let (dir, backend) = repo_with_commit("review-remote");
        commit_on_branch(&dir, &backend, "claude/x", &[("a.md", "one")]);
        let repo = &backend.repo;
        let old = repo
            .find_branch("claude/x", git2::BranchType::Local)
            .unwrap()
            .get()
            .target()
            .unwrap();
        // The remote branch is one commit further than the local one.
        commit_on_branch(
            &dir,
            &backend,
            "claude/x",
            &[("a.md", "one"), ("b.md", "two")],
        );
        let newer = repo
            .find_branch("claude/x", git2::BranchType::Local)
            .unwrap()
            .get()
            .target()
            .unwrap();
        repo.reference("refs/remotes/origin/claude/x", newer, true, "t")
            .unwrap();
        repo.reference("refs/remotes/origin/claude/y", old, true, "t")
            .unwrap();
        repo.find_branch("claude/x", git2::BranchType::Local)
            .unwrap()
            .delete()
            .unwrap();
        repo.branch("claude/x", &repo.find_commit(old).unwrap(), false)
            .unwrap();
        let list = review_branches(&dir, "claude/").unwrap();
        let names: Vec<(&str, bool)> = list.iter().map(|b| (b.name.as_str(), b.remote)).collect();
        assert_eq!(names.len(), 2);
        let x = list.iter().find(|b| b.name == "claude/x").unwrap();
        assert_eq!(x.tip, newer.to_string());
        assert!(x.remote);
        let y = list.iter().find(|b| b.name == "claude/y").unwrap();
        assert!(y.remote);
    }

    #[test]
    fn review_branches_skips_a_branch_without_common_history() {
        let (dir, backend) = repo_with_commit("review-orphan");
        commit_on_branch(&dir, &backend, "claude/ok", &[("a.md", "x")]);
        let repo = &backend.repo;
        let sig = git2::Signature::now("O", "o@example.com").unwrap();
        let tree = repo
            .find_tree(repo.treebuilder(None).unwrap().write().unwrap())
            .unwrap();
        repo.commit(
            Some("refs/heads/claude/orphan"),
            &sig,
            &sig,
            "orphan",
            &tree,
            &[],
        )
        .unwrap();
        let list = review_branches(&dir, "claude/").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "claude/ok");
    }

    #[test]
    fn review_branches_is_empty_without_repository_or_commit() {
        let dir = temp("review-none");
        assert!(review_branches(&dir, "claude/").unwrap().is_empty());
        Repository::init(&dir).unwrap();
        assert!(review_branches(&dir, "claude/").unwrap().is_empty());
    }

    #[test]
    fn review_changes_diffs_against_the_merge_base_not_against_head() {
        let (dir, backend) = repo_with_commit("review-diff");
        commit_file(&dir, &backend, "gone.md", "bye", "add gone");
        commit_on_branch(
            &dir,
            &backend,
            "claude/tidy",
            &[("a.md", "tidy"), ("new.md", "n")],
        );
        let base = backend.repo.head().unwrap().target().unwrap().to_string();
        // Work on the main line after the branch was cut must not show up as a change of the branch.
        commit_file(&dir, &backend, "main.md", "m", "main work");
        fs::remove_file(dir.join("gone.md")).unwrap();
        backend.commit(Some("drop gone"), None).unwrap();
        let r = review_changes(&dir, "claude/tidy").unwrap();
        assert_eq!(r.base, base);
        let got: Vec<(&str, ChangeKind)> = r
            .changes
            .iter()
            .map(|c| (c.path.as_str(), c.kind))
            .collect();
        assert_eq!(
            got,
            vec![
                ("a.md", ChangeKind::Modified),
                ("new.md", ChangeKind::Added)
            ]
        );
        // The "before" and "after" texts come from the base and the tip.
        assert_eq!(note_version(&dir, "a.md", Some(&r.base)).unwrap(), "a");
        assert_eq!(
            note_version(&dir, "a.md", Some("claude/tidy")).unwrap(),
            "tidy"
        );
        assert!(review_changes(&dir, "nope").is_err());
    }

    #[test]
    fn changes_between_lists_added_modified_deleted_notes() {
        let (dir, backend) = repo_with_commit("range");
        commit_file(&dir, &backend, "gone.md", "bye", "add gone");
        let from = backend.repo.head().unwrap().target().unwrap().to_string();
        fs::write(dir.join("a.md"), "changed").unwrap();
        fs::write(dir.join("new.md"), "n").unwrap();
        fs::write(dir.join("img.png"), "x").unwrap();
        fs::remove_file(dir.join("gone.md")).unwrap();
        backend.commit(Some("many"), None).unwrap();
        let c = changes_between(&dir, &from, None).unwrap();
        let got: Vec<(&str, ChangeKind)> = c.iter().map(|c| (c.path.as_str(), c.kind)).collect();
        assert_eq!(
            got,
            vec![
                ("a.md", ChangeKind::Modified),
                ("gone.md", ChangeKind::Deleted),
                ("new.md", ChangeKind::Added),
            ]
        );
        assert!(changes_between(&dir, "HEAD", None).unwrap().is_empty());
        assert!(changes_between(&dir, "nope", None).is_err());
    }

    #[test]
    fn rev_at_finds_the_newest_commit_before_a_time() {
        let (dir, backend) = repo_with_commit("rev-at");
        let head = backend.repo.head().unwrap().target().unwrap().to_string();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert_eq!(rev_at(&dir, now + 60).unwrap(), Some(head));
        assert_eq!(rev_at(&dir, now - 86_400).unwrap(), None);
    }

    #[test]
    fn vault_log_lists_the_commits_newest_first_and_pages() {
        let (dir, backend) = repo_with_commit("vault-log");
        commit_file(&dir, &backend, "b.md", "b", "second");
        commit_file(&dir, &backend, "c.md", "c", "third");
        let all = vault_log(&dir, 0, 10).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].message, "third");
        assert_eq!(all[1].message, "second");
        assert!(!all[0].id.is_empty());
        let page = vault_log(&dir, 1, 1).unwrap();
        assert_eq!(page, vec![all[1].clone()]);
        assert!(vault_log(&dir, 5, 10).unwrap().is_empty());
        let none = temp("vault-log-none");
        assert!(vault_log(&none, 0, 10).unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(none);
    }

    #[test]
    fn recent_notes_lists_changed_notes_once_newest_first() {
        let (dir, backend) = repo_with_commit("recent");
        commit_file(&dir, &backend, "b.md", "b", "add b");
        commit_file(&dir, &backend, "gone.md", "g", "add gone");
        commit_file(&dir, &backend, "img.png", "x", "add img");
        commit_file(&dir, &backend, "b.md", "b2", "edit b");
        fs::remove_file(dir.join("gone.md")).unwrap();
        backend.commit(Some("delete"), None).unwrap();
        let r = recent_notes(&dir, 10, 10).unwrap();
        let paths: Vec<&str> = r.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, vec!["b.md", "a.md"]);
        assert_eq!(r[0].message, "edit b");
        assert_eq!(recent_notes(&dir, 10, 1).unwrap().len(), 1);
        assert_eq!(recent_notes(&dir, 1, 10).unwrap().len(), 0);
        let none = temp("recent-none");
        assert!(recent_notes(&none, 10, 10).unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(none);
    }

    #[test]
    fn deleted_notes_lists_recent_deletions_not_restored() {
        let (dir, backend) = repo_with_commit("deleted");
        commit_file(&dir, &backend, "gone.md", "bye", "add gone");
        commit_file(&dir, &backend, "back.md", "again", "add back");
        commit_file(&dir, &backend, "img.png", "x", "add img");
        for n in ["gone.md", "back.md", "img.png"] {
            fs::remove_file(dir.join(n)).unwrap();
        }
        backend.commit(Some("delete"), None).unwrap();
        commit_file(&dir, &backend, "back.md", "again", "restore back");
        let d = deleted_notes(&dir, 10).unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].path, "gone.md");
        assert_eq!(d[0].message, "delete");
        assert_eq!(
            note_version(&dir, "gone.md", Some(&d[0].parent)).unwrap(),
            "bye"
        );
        // Only the last commits count: the deletion is two commits back.
        assert!(deleted_notes(&dir, 1).unwrap().is_empty());
        assert_eq!(deleted_notes(&dir, 2).unwrap().len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn deleted_notes_is_empty_without_a_repository() {
        let dir = temp("deleted-none");
        assert!(deleted_notes(&dir, 10).unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn history_lists_the_commits_of_a_note_newest_first() {
        let (dir, backend) = repo_with_commit("hist");
        commit_file(&dir, &backend, "b.md", "other", "other note");
        commit_file(&dir, &backend, "a.md", "a2", "edit a");
        let h = note_history(&dir, "a.md", 0, 10).unwrap();
        let msgs: Vec<&str> = h.iter().map(|x| x.message.as_str()).collect();
        assert_eq!(msgs, ["edit a", "init"]);
        assert_eq!(h[0].author, "Config Author");
        assert_eq!(h[1].parent, None);
        let before = h[0].parent.as_deref().unwrap();
        assert_eq!(note_version(&dir, "a.md", Some(before)).unwrap(), "a");
        assert_eq!(note_version(&dir, "a.md", Some(&h[1].id)).unwrap(), "a");
        assert_eq!(note_version(&dir, "a.md", Some(&h[0].id)).unwrap(), "a2");
        assert_eq!(note_version(&dir, "a.md", None).unwrap(), "a2");
        assert_eq!(note_version(&dir, "nope.md", Some("HEAD")).unwrap(), "");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn history_follows_a_rename() {
        let (dir, backend) = repo_with_commit("rename");
        let long = "line one\nline two\nline three\nline four\n";
        commit_file(&dir, &backend, "a.md", long, "write a");
        fs::rename(dir.join("a.md"), dir.join("sub-b.md")).unwrap();
        backend.commit(Some("rename"), None).unwrap();
        commit_file(
            &dir,
            &backend,
            "sub-b.md",
            &format!("{long}five\n"),
            "edit b",
        );
        let h = note_history(&dir, "sub-b.md", 0, 10).unwrap();
        let msgs: Vec<&str> = h.iter().map(|x| x.message.as_str()).collect();
        assert_eq!(msgs, ["edit b", "rename", "write a", "init"]);
        assert_eq!(h[0].path, "sub-b.md");
        assert_eq!(h[1].path, "sub-b.md");
        assert_eq!(h[1].parent_path, "a.md");
        assert_eq!(h[2].path, "a.md");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn history_pages_and_handles_500_commits() {
        let (dir, backend) = repo_with_commit("many");
        for i in 0..499 {
            commit_file(&dir, &backend, "a.md", &format!("v{i}"), &format!("c{i}"));
        }
        let start = std::time::Instant::now();
        let all = note_history(&dir, "a.md", 0, 1000).unwrap();
        assert!(start.elapsed().as_secs_f64() < 1.0, "{:?}", start.elapsed());
        assert_eq!(all.len(), 500);
        let page = note_history(&dir, "a.md", 100, 50).unwrap();
        assert_eq!(page.len(), 50);
        assert_eq!(page[0], all[100]);
        assert!(note_history(&dir, "a.md", 500, 50).unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn history_of_a_folder_without_repository_is_empty() {
        let dir = temp("hist-none");
        assert!(note_history(&dir, "a.md", 0, 10).unwrap().is_empty());
        assert!(note_version(&dir, "a.md", Some("HEAD")).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_without_repository_has_no_git() {
        let dir = temp("none");
        assert!(Git2Backend::open(&dir).is_none());
        assert_eq!(vault_status(&dir).unwrap(), None);
        assert!(vault_commit(&dir, None, None).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_repository_further_up_does_not_count() {
        let dir = temp("nested");
        Repository::init(&dir).unwrap();
        let sub = dir.join("vault");
        fs::create_dir_all(&sub).unwrap();
        assert!(Git2Backend::open(&sub).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lists_added_modified_and_deleted_notes() {
        let (dir, backend) = repo_with_commit("status");
        fs::write(dir.join("b.md"), "new").unwrap();
        fs::write(dir.join("a.md"), "changed").unwrap();
        let status = backend.status().unwrap();
        assert_eq!(
            status.changes,
            vec![
                GitChange {
                    path: "a.md".into(),
                    kind: ChangeKind::Modified,
                    untracked: false,
                    pair: None
                },
                GitChange {
                    path: "b.md".into(),
                    kind: ChangeKind::Added,
                    untracked: true,
                    pair: None
                },
            ]
        );
        fs::remove_file(dir.join("a.md")).unwrap();
        let status = backend.status().unwrap();
        assert_eq!(
            status.changes[0],
            GitChange {
                path: "a.md".into(),
                kind: ChangeKind::Deleted,
                untracked: false,
                pair: None
            }
        );
        assert!(status.branch.is_some());
        assert_eq!((status.ahead, status.behind), (0, 0));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_new_repository_reports_its_unborn_branch() {
        let dir = temp("unborn");
        let backend = Git2Backend {
            repo: Repository::init(&dir).unwrap(),
        };
        fs::write(dir.join("a.md"), "a").unwrap();
        let status = backend.status().unwrap();
        assert!(status.branch.is_some());
        assert_eq!(status.changes.len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn gitignore_missing_lists_all_entries_without_a_gitignore() {
        let (dir, _b) = repo_with_commit("gi-none");
        assert_eq!(
            gitignore_missing(&dir).unwrap().unwrap(),
            vec![".nixe/local/", ".*.nixe-tmp", ".trash/"]
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn gitignore_missing_counts_other_patterns_as_covered() {
        let (dir, _b) = repo_with_commit("gi-covered");
        fs::write(dir.join(".gitignore"), ".nixe/*\n*.nixe-tmp\n").unwrap();
        assert_eq!(gitignore_missing(&dir).unwrap().unwrap(), vec![".trash/"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn gitignore_missing_is_none_without_a_repository() {
        let dir = temp("gi-norepo");
        assert_eq!(gitignore_missing(&dir).unwrap(), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn gitignore_add_appends_only_the_missing_lines() {
        let (dir, _b) = repo_with_commit("gi-add");
        fs::write(dir.join(".gitignore"), "z.log\n.trash/\nbuild").unwrap();
        let added = gitignore_add(&dir).unwrap();
        assert_eq!(added, vec![".nixe/local/", ".*.nixe-tmp"]);
        assert_eq!(
            fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "z.log\n.trash/\nbuild\n\n# Nixe\n.nixe/local/\n.*.nixe-tmp\n"
        );
        assert!(gitignore_missing(&dir).unwrap().unwrap().is_empty());
        assert!(gitignore_add(&dir).unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn gitignore_add_creates_the_file() {
        let (dir, _b) = repo_with_commit("gi-create");
        gitignore_add(&dir).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "# Nixe\n.nixe/local/\n.*.nixe-tmp\n.trash/\n"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn gitignore_ensure_appends_once_and_keeps_the_file() {
        let (dir, _b) = repo_with_commit("gitignore-ensure");
        fs::write(dir.join(".gitignore"), "z.log").unwrap();
        assert!(gitignore_ensure(&dir, "Links/.archive/").unwrap());
        assert_eq!(
            fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "z.log\n\n# Nixe\nLinks/.archive/\n"
        );
        assert!(!gitignore_ensure(&dir, "Links/.archive/").unwrap());
        assert_eq!(
            fs::read_to_string(dir.join(".gitignore"))
                .unwrap()
                .matches("Links/.archive/")
                .count(),
            1
        );
    }

    #[test]
    fn gitignore_ensure_works_without_a_repository() {
        let dir = temp("gitignore-ensure-plain");
        assert!(gitignore_ensure(&dir, "Links/.archive").unwrap());
        assert!(!gitignore_ensure(&dir, "Links/.archive/").unwrap());
        assert_eq!(
            fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "# Nixe\nLinks/.archive/\n"
        );
    }

    #[test]
    fn gitignore_dismiss_hides_the_hint() {
        let (dir, _b) = repo_with_commit("gi-dismiss");
        gitignore_dismiss(&dir).unwrap();
        assert!(dir.join(".nixe/local").is_dir());
        assert!(gitignore_missing(&dir).unwrap().unwrap().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn status_tells_whether_a_remote_is_set() {
        let (dir, backend) = repo_with_commit("hasremote");
        assert!(!backend.status().unwrap().has_remote);
        backend.repo.remote("origin", "file:///nowhere").unwrap();
        assert!(backend.status().unwrap().has_remote);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn counts_ahead_and_behind_of_the_upstream() {
        let (dir, backend) = repo_with_commit("aheadbehind");
        let origin = temp("aheadbehind-origin");
        Repository::init_bare(&origin).unwrap();
        let repo = &backend.repo;
        let branch = backend.status().unwrap().branch.unwrap();
        repo.remote("origin", origin.to_str().unwrap()).unwrap();
        let mut remote = repo.find_remote("origin").unwrap();
        let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
        remote.push(&[spec], None).unwrap();
        remote.fetch(&[&branch], None, None).unwrap();
        repo.find_branch(&branch, git2::BranchType::Local)
            .unwrap()
            .set_upstream(Some(&format!("origin/{branch}")))
            .unwrap();
        assert_eq!(
            (
                backend.status().unwrap().ahead,
                backend.status().unwrap().behind
            ),
            (0, 0)
        );
        fs::write(dir.join("b.md"), "b").unwrap();
        backend.commit(Some("second"), None).unwrap();
        let status = backend.status().unwrap();
        assert_eq!((status.ahead, status.behind), (1, 0));

        // Publish the second commit, then reset the local branch behind it.
        let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
        repo.find_remote("origin")
            .unwrap()
            .push(&[spec], None)
            .unwrap();
        repo.find_remote("origin")
            .unwrap()
            .fetch(&[&branch], None, None)
            .unwrap();
        assert_eq!(
            {
                let s = backend.status().unwrap();
                (s.ahead, s.behind)
            },
            (0, 0)
        );
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let first = head.parent(0).unwrap();
        repo.reset(first.as_object(), git2::ResetType::Hard, None)
            .unwrap();
        let status = backend.status().unwrap();
        assert_eq!((status.ahead, status.behind), (0, 1));
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(origin);
    }

    #[test]
    fn commit_stages_adds_changes_and_deletions() {
        let (dir, backend) = repo_with_commit("commit");
        fs::write(dir.join("b.md"), "new").unwrap();
        fs::remove_file(dir.join("a.md")).unwrap();
        backend.commit(Some("  my message  "), None).unwrap();
        assert!(backend.status().unwrap().changes.is_empty());
        let head = backend.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().ok(), Some("my message"));
        let tree = head.tree().unwrap();
        assert!(tree.get_name("b.md").is_some());
        assert!(tree.get_name("a.md").is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_partial_save_takes_only_the_chosen_notes() {
        let (dir, backend) = repo_with_commit("partial");
        commit_file(&dir, &backend, "mod.md", "old", "m");
        commit_file(&dir, &backend, "del.md", "gone", "d");
        commit_file(&dir, &backend, "old-name.md", "same text", "r");
        commit_file(&dir, &backend, "keep-mod.md", "k", "k");
        commit_file(&dir, &backend, "keep-del.md", "k", "k2");
        fs::write(dir.join("mod.md"), "changed").unwrap();
        fs::write(dir.join("new.md"), "fresh").unwrap();
        fs::remove_file(dir.join("del.md")).unwrap();
        fs::rename(dir.join("old-name.md"), dir.join("new-name.md")).unwrap();
        fs::write(dir.join("keep-mod.md"), "kept open").unwrap();
        fs::remove_file(dir.join("keep-del.md")).unwrap();
        fs::write(dir.join("keep-new.md"), "open").unwrap();

        let paths: Vec<String> = ["mod.md", "new.md", "del.md", "old-name.md", "new-name.md"]
            .map(String::from)
            .to_vec();
        backend.commit_paths(&paths, Some("part"), None).unwrap();

        let tree = backend.repo.head().unwrap().peel_to_tree().unwrap();
        let text = |name: &str| {
            let blob = tree
                .get_name(name)
                .unwrap()
                .to_object(&backend.repo)
                .unwrap();
            String::from_utf8(blob.as_blob().unwrap().content().to_vec()).unwrap()
        };
        assert_eq!(text("mod.md"), "changed");
        assert_eq!(text("new.md"), "fresh");
        assert!(tree.get_name("del.md").is_none());
        assert!(tree.get_name("old-name.md").is_none());
        assert_eq!(text("new-name.md"), "same text");
        // The others stay open.
        assert_eq!(text("keep-mod.md"), "k");
        assert!(tree.get_name("keep-del.md").is_some());
        assert!(tree.get_name("keep-new.md").is_none());
        let open: Vec<(String, ChangeKind)> = backend
            .status()
            .unwrap()
            .changes
            .into_iter()
            .map(|c| (c.path, c.kind))
            .collect();
        assert_eq!(
            open,
            vec![
                ("keep-del.md".to_string(), ChangeKind::Deleted),
                ("keep-mod.md".to_string(), ChangeKind::Modified),
                ("keep-new.md".to_string(), ChangeKind::Added),
            ]
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_partial_save_leaves_out_what_was_staged_before() {
        let (dir, backend) = repo_with_commit("partial-staged");
        fs::write(dir.join("staged.md"), "s").unwrap();
        let mut index = backend.repo.index().unwrap();
        index.add_path(Path::new("staged.md")).unwrap();
        index.write().unwrap();
        fs::write(dir.join("b.md"), "b").unwrap();
        backend
            .commit_paths(&["b.md".to_string()], None, None)
            .unwrap();
        let tree = backend.repo.head().unwrap().peel_to_tree().unwrap();
        assert!(tree.get_name("b.md").is_some());
        assert!(tree.get_name("staged.md").is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_partial_save_refuses_an_empty_choice_and_paths_outside_the_vault() {
        let (dir, backend) = repo_with_commit("partial-empty");
        fs::write(dir.join("b.md"), "b").unwrap();
        assert_eq!(
            backend.commit_paths(&[], None, None).unwrap_err(),
            "nothing to commit"
        );
        assert!(backend
            .commit_paths(&["../x.md".to_string()], None, None)
            .is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_partial_save_works_in_a_repository_without_a_commit() {
        let dir = temp("partial-unborn");
        let repo = Repository::init(&dir).unwrap();
        repo.config().unwrap().set_str("user.name", "A").unwrap();
        repo.config()
            .unwrap()
            .set_str("user.email", "a@b.c")
            .unwrap();
        fs::write(dir.join("a.md"), "a").unwrap();
        fs::write(dir.join("b.md"), "b").unwrap();
        let backend = Git2Backend { repo };
        backend
            .commit_paths(&["a.md".to_string()], None, None)
            .unwrap();
        let tree = backend.repo.head().unwrap().peel_to_tree().unwrap();
        assert!(tree.get_name("a.md").is_some());
        assert!(tree.get_name("b.md").is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_renamed_note_is_reported_as_a_pair() {
        let (dir, backend) = repo_with_commit("pairs");
        fs::create_dir(dir.join("sub")).unwrap();
        fs::rename(dir.join("a.md"), dir.join("sub/moved.md")).unwrap();
        fs::write(dir.join("other.md"), "different").unwrap();
        let changes = backend.status().unwrap().changes;
        let pair = |path: &str| {
            changes
                .iter()
                .find(|c| c.path == path)
                .unwrap()
                .pair
                .clone()
        };
        assert_eq!(pair("a.md").as_deref(), Some("sub/moved.md"));
        assert_eq!(pair("sub/moved.md").as_deref(), Some("a.md"));
        assert_eq!(pair("other.md"), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_uses_the_default_message_and_refuses_an_empty_commit() {
        let (dir, backend) = repo_with_commit("default");
        assert_eq!(backend.commit(None, None).unwrap_err(), "nothing to commit");
        fs::write(dir.join("b.md"), "b").unwrap();
        backend.commit(Some("  "), None).unwrap();
        let head = backend.repo.head().unwrap().peel_to_commit().unwrap();
        let message = head.message().unwrap();
        assert!(message.starts_with("vault backup: 20"), "{message}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_author_comes_from_the_git_config() {
        let (dir, backend) = repo_with_commit("author-config");
        fs::write(dir.join("b.md"), "b").unwrap();
        let fallback = Identity {
            name: "Settings".into(),
            email: "s@example.com".into(),
        };
        backend.commit(Some("m"), Some(&fallback)).unwrap();
        let head = backend.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.author().name().ok(), Some("Config Author"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_author_falls_back_to_the_settings() {
        // No identity in the repository config; isolate from the user's global config.
        let dir = temp("author-settings");
        let repo = Repository::init(&dir).unwrap();
        let empty = temp("author-settings-cfg");
        let mut cfg = git2::Config::new().unwrap();
        cfg.add_file(&empty.join("config"), git2::ConfigLevel::App, true)
            .unwrap_or(());
        repo.set_config(&mut cfg).unwrap();
        fs::write(dir.join("a.md"), "a").unwrap();
        let backend = Git2Backend { repo };
        let err = backend.commit(Some("m"), None).unwrap_err();
        assert!(err.contains("no author"), "{err}");
        let blank = Identity {
            name: " ".into(),
            email: "x@y".into(),
        };
        assert!(backend.commit(Some("m"), Some(&blank)).is_err());
        let fallback = Identity {
            name: "Settings".into(),
            email: "s@example.com".into(),
        };
        backend.commit(Some("m"), Some(&fallback)).unwrap();
        let head = backend.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.author().name().ok(), Some("Settings"));
        assert_eq!(head.author().email().ok(), Some("s@example.com"));
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(empty);
    }

    fn changes_of(dir: &Path) -> Vec<(String, ChangeKind)> {
        vault_status(dir)
            .unwrap()
            .unwrap()
            .changes
            .into_iter()
            .map(|c| (c.path, c.kind))
            .collect()
    }

    #[test]
    fn restore_writes_an_older_version_keeps_the_current_one_and_undo_brings_it_back() {
        let (dir, backend) = repo_with_commit("restore-ver");
        let old = backend.repo.head().unwrap().peel_to_commit().unwrap().id();
        fs::write(dir.join("a.md"), "second").unwrap();
        backend.commit(Some("second"), None).unwrap();
        fs::write(dir.join("a.md"), "third, unsaved").unwrap();
        let op = restore_note(&dir, "a.md", "a.md", &old.to_string(), None).unwrap();
        assert_eq!(op.kind, "restore");
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "a");
        assert!(changes_of(&dir).is_empty());
        // The unsaved state was committed before, so it is in the history.
        let history = note_history(&dir, "a.md", 0, 10).unwrap();
        assert_eq!(history.len(), 4);
        undo_operation(&dir, None).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("a.md")).unwrap(),
            "third, unsaved"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_refuses_a_bad_path_a_missing_version_and_the_same_content() {
        let (dir, backend) = repo_with_commit("restore-bad");
        let head = backend
            .repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string();
        assert!(restore_note(&dir, "../x.md", "a.md", &head, None).is_err());
        assert!(restore_note(&dir, "a.md", "nope.md", &head, None).is_err());
        assert!(restore_note(&dir, "a.md", "a.md", "deadbeef", None).is_err());
        assert!(restore_note(&dir, "a.md", "a.md", &head, None)
            .unwrap_err()
            .contains("already"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn discard_gives_a_changed_note_its_saved_version_and_undo_brings_the_edit_back() {
        let (dir, _backend) = repo_with_commit("discard-mod");
        fs::write(dir.join("a.md"), "edited").unwrap();
        let op = discard_note(&dir, "a.md", None).unwrap();
        assert_eq!(op.kind, "discard");
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "a");
        assert!(changes_of(&dir).is_empty());
        undo_operation(&dir, None).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "edited");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn discard_removes_a_new_note_and_its_empty_folder_and_undo_restores_it() {
        let (dir, _backend) = repo_with_commit("discard-new");
        fs::create_dir_all(dir.join("sub/deep")).unwrap();
        fs::write(dir.join("sub/deep/n.md"), "new").unwrap();
        fs::write(dir.join("other.md"), "keep").unwrap();
        discard_note(&dir, "sub/deep/n.md", None).unwrap();
        assert!(!dir.join("sub").exists());
        // The other open change stays.
        assert_eq!(fs::read_to_string(dir.join("other.md")).unwrap(), "keep");
        assert_eq!(
            changes_of(&dir),
            [("other.md".to_string(), ChangeKind::Added)]
        );
        undo_operation(&dir, None).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("sub/deep/n.md")).unwrap(),
            "new"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn discard_restores_a_deleted_note_also_in_a_removed_folder() {
        let (dir, backend) = repo_with_commit("discard-del");
        fs::create_dir_all(dir.join("old")).unwrap();
        commit_file(&dir, &backend, "old/d.md", "deleted text", "add d");
        fs::remove_dir_all(dir.join("old")).unwrap();
        assert_eq!(
            changes_of(&dir),
            [("old/d.md".to_string(), ChangeKind::Deleted)]
        );
        discard_note(&dir, "old/d.md", None).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("old/d.md")).unwrap(),
            "deleted text"
        );
        assert!(changes_of(&dir).is_empty());
        undo_operation(&dir, None).unwrap();
        assert!(!dir.join("old/d.md").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn discard_handles_the_two_sides_of_a_rename_one_at_a_time() {
        let (dir, _backend) = repo_with_commit("discard-rename");
        fs::rename(dir.join("a.md"), dir.join("b.md")).unwrap();
        let seen = changes_of(&dir);
        assert_eq!(
            seen,
            [
                ("a.md".to_string(), ChangeKind::Deleted),
                ("b.md".to_string(), ChangeKind::Added)
            ]
        );
        // The new name goes away, the old note stays deleted.
        discard_note(&dir, "b.md", None).unwrap();
        assert!(!dir.join("b.md").exists());
        assert_eq!(
            changes_of(&dir),
            [("a.md".to_string(), ChangeKind::Deleted)]
        );
        // The old name comes back.
        discard_note(&dir, "a.md", None).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "a");
        assert!(changes_of(&dir).is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn discard_refuses_unchanged_notes_and_paths_outside_the_vault() {
        let (dir, _backend) = repo_with_commit("discard-refuse");
        assert!(discard_note(&dir, "a.md", None)
            .unwrap_err()
            .contains("no changes"));
        for bad in ["", "../x.md", "/etc/passwd", ".git/config", "sub/../a.md"] {
            assert!(discard_note(&dir, bad, None).is_err(), "{bad}");
        }
        let plain = temp("discard-nogit");
        assert!(discard_note(&plain, "a.md", None)
            .unwrap_err()
            .contains("not a Git repository"));
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(plain);
    }

    #[test]
    fn formats_timestamps_in_utc() {
        assert_eq!(format_timestamp(0), "1970-01-01 00:00:00");
        assert_eq!(format_timestamp(1_709_210_096), "2024-02-29 12:34:56");
        assert_eq!(format_timestamp(951_782_400), "2000-02-29 00:00:00");
    }
}
