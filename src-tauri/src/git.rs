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
