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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitStatus {
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    pub changes: Vec<GitChange>,
    pub ahead: usize,
    pub behind: usize,
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
                Some(GitChange {
                    path: s.path().ok()?.to_owned(),
                    kind: kind_of(s.status())?,
                })
            })
            .collect();
        changes.sort_by(|a, b| a.path.cmp(&b.path));

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
        Ok(GitStatus {
            branch,
            changes,
            ahead,
            behind,
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
}

/// `None` when the vault is not a Git repository: the UI then shows nothing of Git.
pub fn vault_status(root: &Path) -> Result<Option<GitStatus>, String> {
    Git2Backend::open(root).map(|b| b.status()).transpose()
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
    use std::fs;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-git-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// A repository with an identity in its own config and one commit of `a.md`.
    fn repo_with_commit(name: &str) -> (PathBuf, Git2Backend) {
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
                    kind: ChangeKind::Modified
                },
                GitChange {
                    path: "b.md".into(),
                    kind: ChangeKind::Added
                },
            ]
        );
        fs::remove_file(dir.join("a.md")).unwrap();
        let status = backend.status().unwrap();
        assert_eq!(
            status.changes[0],
            GitChange {
                path: "a.md".into(),
                kind: ChangeKind::Deleted
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

    #[test]
    fn formats_timestamps_in_utc() {
        assert_eq!(format_timestamp(0), "1970-01-01 00:00:00");
        assert_eq!(format_timestamp(1_709_210_096), "2024-02-29 12:34:56");
        assert_eq!(format_timestamp(951_782_400), "2000-02-29 00:00:00");
    }
}
