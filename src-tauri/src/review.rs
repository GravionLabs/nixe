//! Accept or reject the changes of a review branch per note and hunk, and merge the result (#109).
//!
//! The hunks of a note are the line differences between the merge base and the branch tip. The
//! accepted ones (possibly edited) are applied to the base text; that text is then merged three
//! ways with the note as it is in the vault now. A note that does not merge cleanly is reported
//! with both versions and nothing is written until the user has decided on every one of them.

use std::fs;
use std::path::Path;

use git2::{BranchType, DiffOptions, IndexEntry, Patch, Repository, Signature};
use serde::{Deserialize, Serialize};

use crate::credentials::TokenStore;
use crate::git::{notes_changed, ChangeKind, Identity};
use crate::gitsync;

fn e(err: git2::Error) -> String {
    err.message().to_owned()
}

/// One block of changed lines of a note. The indices are 0-based line numbers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewHunk {
    pub index: usize,
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    /// The lines of the merge base this hunk replaces.
    pub old: String,
    /// The lines the branch has instead.
    pub new: String,
}

#[derive(Debug, Clone, Copy)]
struct Range {
    old_start: usize,
    old_lines: usize,
    new_start: usize,
    new_lines: usize,
}

/// How the user wants a note that does not merge cleanly to end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Resolve {
    /// Keep the note as it is in the vault.
    Mine,
    /// Replace it with the accepted version of the branch.
    Branch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkDecision {
    pub index: usize,
    pub accept: bool,
    /// The edited replacement for the hunk; `None` takes the lines of the branch.
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDecision {
    pub path: String,
    /// A note without hunks (an empty file) is accepted as a whole with this flag.
    #[serde(default)]
    pub accepted: bool,
    #[serde(default)]
    pub hunks: Vec<HunkDecision>,
    pub resolve: Option<Resolve>,
}

/// A note that cannot be merged without losing something: both versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewConflict {
    pub path: String,
    /// The note in the vault now; `None` when it is deleted there.
    pub mine: Option<String>,
    /// The accepted version of the branch; `None` when the branch deletes the note.
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOutcome {
    /// The commit with the accepted changes; `None` when nothing was accepted or on conflicts.
    pub commit: Option<String>,
    /// Notes written or deleted.
    pub applied: Vec<String>,
    /// Not empty: nothing was written, resolve these first.
    pub conflicts: Vec<ReviewConflict>,
    /// The branch was deleted locally.
    pub branch_deleted: bool,
    /// The remote branch could not be deleted (the commit and the local deletion stand).
    pub warning: Option<String>,
}

fn blob_text(repo: &Repository, commit: git2::Oid, path: &str) -> Option<String> {
    let tree = repo.find_commit(commit).ok()?.tree().ok()?;
    let entry = tree.get_path(Path::new(path)).ok()?;
    let blob = repo.find_blob(entry.id()).ok()?;
    Some(String::from_utf8_lossy(blob.content()).into_owned())
}

fn ranges(old: &str, new: &str) -> Result<Vec<Range>, String> {
    let mut opts = DiffOptions::new();
    opts.context_lines(0);
    let patch = Patch::from_buffers(old.as_bytes(), None, new.as_bytes(), None, Some(&mut opts))
        .map_err(e)?;
    let mut out = Vec::new();
    for i in 0..patch.num_hunks() {
        let (h, _) = patch.hunk(i).map_err(e)?;
        // With no context an empty side names the line *before* the change.
        let start = |start: u32, lines: u32| {
            if lines == 0 {
                start as usize
            } else {
                start as usize - 1
            }
        };
        out.push(Range {
            old_start: start(h.old_start(), h.old_lines()),
            old_lines: h.old_lines() as usize,
            new_start: start(h.new_start(), h.new_lines()),
            new_lines: h.new_lines() as usize,
        });
    }
    Ok(out)
}

fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

fn resolve_rev(repo: &Repository, rev: &str) -> Result<(git2::Oid, git2::Oid), String> {
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
    let base = repo.merge_base(head, tip).map_err(e)?;
    Ok((base, tip))
}

/// The hunks of one note of the branch `tip` against the merge base with HEAD.
pub fn review_hunks(root: &Path, tip: &str, path: &str) -> Result<Vec<ReviewHunk>, String> {
    let repo = Repository::open(root).map_err(|_| "the vault is not a Git repository")?;
    let (base, tip) = resolve_rev(&repo, tip)?;
    let old = blob_text(&repo, base, path).unwrap_or_default();
    let new = blob_text(&repo, tip, path).unwrap_or_default();
    let (ol, nl) = (lines(&old), lines(&new));
    Ok(ranges(&old, &new)?
        .into_iter()
        .enumerate()
        .map(|(index, r)| ReviewHunk {
            index,
            old_start: r.old_start,
            old_lines: r.old_lines,
            new_start: r.new_start,
            new_lines: r.new_lines,
            old: ol[r.old_start..r.old_start + r.old_lines].concat(),
            new: nl[r.new_start..r.new_start + r.new_lines].concat(),
        })
        .collect())
}

/// The base text with the accepted hunks applied; `(text, accepted, all)`.
fn compose(old: &str, new: &str, decision: &NoteDecision) -> Result<(String, bool, bool), String> {
    let (ol, nl) = (lines(old), lines(new));
    let rs = ranges(old, new)?;
    let mut out = String::new();
    let mut pos = 0;
    let (mut any, mut all) = (false, true);
    for (i, r) in rs.iter().enumerate() {
        out.push_str(&ol[pos..r.old_start].concat());
        let d = decision.hunks.iter().find(|d| d.index == i && d.accept);
        match d {
            Some(d) => {
                any = true;
                match &d.text {
                    Some(text) => {
                        out.push_str(text);
                        if !text.is_empty()
                            && !text.ends_with('\n')
                            && r.old_start + r.old_lines < ol.len()
                        {
                            out.push('\n');
                        }
                    }
                    None => out.push_str(&nl[r.new_start..r.new_start + r.new_lines].concat()),
                }
            }
            None => {
                all = false;
                out.push_str(&ol[r.old_start..r.old_start + r.old_lines].concat());
            }
        }
        pos = r.old_start + r.old_lines;
    }
    out.push_str(&ol[pos..].concat());
    if rs.is_empty() {
        (any, all) = (decision.accepted, decision.accepted);
    }
    Ok((out, any, all))
}

fn entry(repo: &Repository, path: &str, text: &str) -> Result<IndexEntry, String> {
    Ok(IndexEntry {
        ctime: git2::IndexTime::new(0, 0),
        mtime: git2::IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: 0o100644,
        uid: 0,
        gid: 0,
        file_size: text.len() as u32,
        id: repo.blob(text.as_bytes()).map_err(e)?,
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    })
}

/// Three-way merge of `theirs` into `mine`; `None` when they overlap.
fn merge3(
    repo: &Repository,
    path: &str,
    base: Option<&str>,
    mine: &str,
    theirs: &str,
) -> Result<Option<String>, String> {
    let ancestor = base.map(|b| entry(repo, path, b)).transpose()?;
    let result = repo
        .merge_file_from_index(
            ancestor.as_ref().unwrap_or(&entry(repo, path, "")?),
            &entry(repo, path, mine)?,
            &entry(repo, path, theirs)?,
            None,
        )
        .map_err(e)?;
    if !result.is_automergeable() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(result.content()).into_owned()))
}

/// What happens to one note: the text to write, or its deletion.
enum Action {
    Write(String),
    Delete,
}

/// Commits the accepted changes of the branch onto the working branch and, when asked, deletes the
/// branch. Without conflicts the vault changes in one step; with conflicts nothing changes.
pub fn review_finish(
    root: &Path,
    name: &str,
    tip: &str,
    decisions: &[NoteDecision],
    delete_branch: bool,
    fallback: Option<&Identity>,
    store: &dyn TokenStore,
) -> Result<ReviewOutcome, String> {
    let repo = Repository::open(root).map_err(|_| "the vault is not a Git repository")?;
    let (base, tip_id) = resolve_rev(&repo, tip)?;
    let changes = notes_changed(&repo, &base.to_string(), &tip_id.to_string())?;
    let mut outcome = ReviewOutcome::default();
    let mut actions: Vec<(String, Action)> = Vec::new();

    for d in decisions {
        if d.resolve == Some(Resolve::Mine) {
            continue;
        }
        let Some(change) = changes.iter().find(|c| c.path == d.path) else {
            continue;
        };
        let old = blob_text(&repo, base, &d.path);
        let new = blob_text(&repo, tip_id, &d.path);
        let (text, any, all) = compose(
            old.as_deref().unwrap_or(""),
            new.as_deref().unwrap_or(""),
            d,
        )?;
        if !any {
            continue;
        }
        let target = if change.kind == ChangeKind::Deleted && all {
            None
        } else {
            Some(text)
        };
        let abs = root.join(&d.path);
        let mine = fs::read_to_string(&abs).ok();
        let forced = d.resolve == Some(Resolve::Branch);
        let action = match (&target, &mine) {
            (None, None) => continue,
            (None, Some(m)) if forced || old.as_deref() == Some(m.as_str()) => Action::Delete,
            (Some(t), Some(m)) if m == t => continue,
            (Some(t), _) if forced => Action::Write(t.clone()),
            (Some(t), None) if old.is_none() => Action::Write(t.clone()),
            (Some(t), Some(m)) if old.as_deref() == Some(m.as_str()) => Action::Write(t.clone()),
            (Some(t), Some(m)) => match merge3(&repo, &d.path, old.as_deref(), m, t)? {
                Some(merged) => Action::Write(merged),
                None => {
                    outcome.conflicts.push(ReviewConflict {
                        path: d.path.clone(),
                        mine: mine.clone(),
                        branch: target.clone(),
                    });
                    continue;
                }
            },
            _ => {
                outcome.conflicts.push(ReviewConflict {
                    path: d.path.clone(),
                    mine: mine.clone(),
                    branch: target.clone(),
                });
                continue;
            }
        };
        actions.push((d.path.clone(), action));
    }
    if !outcome.conflicts.is_empty() {
        return Ok(outcome);
    }

    for (path, action) in &actions {
        let abs = root.join(path);
        match action {
            Action::Write(text) => {
                if let Some(parent) = abs.parent() {
                    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                }
                fs::write(&abs, text).map_err(|err| err.to_string())?;
            }
            Action::Delete => fs::remove_file(&abs).map_err(|err| err.to_string())?,
        }
        outcome.applied.push(path.clone());
    }
    if !actions.is_empty() {
        let head = repo.head().map_err(e)?.peel_to_commit().map_err(e)?;
        let mut index = repo.index().map_err(e)?;
        index.read_tree(&head.tree().map_err(e)?).map_err(e)?;
        for (path, action) in &actions {
            match action {
                Action::Write(_) => index.add_path(Path::new(path)).map_err(e)?,
                Action::Delete => index.remove_path(Path::new(path)).map_err(e)?,
            }
        }
        index.write().map_err(e)?;
        let tree = repo.find_tree(index.write_tree().map_err(e)?).map_err(e)?;
        let sig = match repo.signature() {
            Ok(sig) => sig,
            Err(_) => {
                let id = fallback
                    .filter(|i| !i.name.trim().is_empty() && !i.email.trim().is_empty())
                    .ok_or("no author: set user.name and user.email in the Git config or in the settings")?;
                Signature::now(id.name.trim(), id.email.trim()).map_err(e)?
            }
        };
        let message = format!(
            "review: accept changes from {name}\n\nAccepted {} of {} changed notes.",
            actions.len(),
            changes.len()
        );
        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&head])
            .map_err(e)?;
        outcome.commit = Some(oid.to_string());
    }
    if delete_branch {
        delete_review_branch(&repo, name, store, &mut outcome)?;
    }
    clear_state(&repo, name);
    Ok(outcome)
}

fn delete_review_branch(
    repo: &Repository,
    name: &str,
    store: &dyn TokenStore,
    outcome: &mut ReviewOutcome,
) -> Result<(), String> {
    if let Ok(mut local) = repo.find_branch(name, BranchType::Local) {
        local.delete().map_err(e)?;
        outcome.branch_deleted = true;
    }
    // Remote-tracking refs of the branch: `<remote>/<name>`.
    let mut remotes: Vec<String> = Vec::new();
    for item in repo.branches(Some(BranchType::Remote)).map_err(e)? {
        let (branch, _) = item.map_err(e)?;
        if let Some((remote, rest)) = branch.name().map_err(e)?.and_then(|n| n.split_once('/')) {
            if rest == name {
                remotes.push(remote.to_owned());
            }
        }
    }
    for remote in remotes {
        match push_delete(repo, &remote, name, store) {
            Ok(()) => {
                if let Ok(mut tracking) =
                    repo.find_branch(&format!("{remote}/{name}"), BranchType::Remote)
                {
                    let _ = tracking.delete();
                }
                outcome.branch_deleted = true;
            }
            Err(err) => {
                outcome.warning = Some(format!("the branch stays on {remote}: {err}"));
            }
        }
    }
    Ok(())
}

fn push_delete(
    repo: &Repository,
    remote: &str,
    name: &str,
    store: &dyn TokenStore,
) -> Result<(), String> {
    let url = repo
        .find_remote(remote)
        .map_err(e)?
        .url()
        .unwrap_or_default()
        .to_owned();
    gitsync::with_auth(&url, store, |auth| {
        let mut options = git2::PushOptions::new();
        options.remote_callbacks(gitsync::callbacks(auth));
        repo.find_remote(remote)?
            .push(&[format!(":refs/heads/{name}")], Some(&mut options))
    })
}

fn state_file(repo: &Repository, name: &str) -> std::path::PathBuf {
    let mut file = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            file.push(b as char);
        } else {
            file.push_str(&format!(".{b:02x}"));
        }
    }
    repo.path().join("nixe-review").join(format!("{file}.json"))
}

fn clear_state(repo: &Repository, name: &str) {
    let _ = fs::remove_file(state_file(repo, name));
}

/// The saved, unfinished decisions of a branch (an opaque JSON text of the frontend).
pub fn review_state_load(root: &Path, name: &str) -> Result<Option<String>, String> {
    let repo = Repository::open(root).map_err(|_| "the vault is not a Git repository")?;
    Ok(fs::read_to_string(state_file(&repo, name)).ok())
}

/// Saves the decisions of a branch inside the Git directory, so they survive a restart and stay
/// out of the vault. `None` removes them.
pub fn review_state_save(root: &Path, name: &str, state: Option<&str>) -> Result<(), String> {
    let repo = Repository::open(root).map_err(|_| "the vault is not a Git repository")?;
    let file = state_file(&repo, name);
    match state {
        Some(text) => {
            if let Some(dir) = file.parent() {
                fs::create_dir_all(dir).map_err(|err| err.to_string())?;
            }
            fs::write(&file, text).map_err(|err| err.to_string())
        }
        None => {
            clear_state(&repo, name);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryStore;
    use crate::test_dir::TestDir;

    fn temp(name: &str) -> TestDir {
        TestDir::new(&format!("nixe-review-{name}-"))
    }

    fn init(name: &str) -> (TestDir, Repository) {
        let dir = temp(name);
        let repo = Repository::init(&dir).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Tester").unwrap();
        cfg.set_str("user.email", "t@example.com").unwrap();
        (dir, repo)
    }

    /// Commits the given files (`None` deletes) on the current HEAD.
    fn commit(dir: &Path, repo: &Repository, files: &[(&str, Option<&str>)], msg: &str) {
        let mut index = repo.index().unwrap();
        for (file, text) in files {
            match text {
                Some(t) => {
                    fs::write(dir.join(file), t).unwrap();
                    index.add_path(Path::new(file)).unwrap();
                }
                None => {
                    fs::remove_file(dir.join(file)).unwrap();
                    index.remove_path(Path::new(file)).unwrap();
                }
            }
        }
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap();
    }

    /// Cuts `branch` from HEAD, commits there, and returns to the working branch.
    fn on_branch(dir: &Path, repo: &Repository, branch: &str, files: &[(&str, Option<&str>)]) {
        let work = repo.head().unwrap().name().unwrap().to_owned();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch(branch, &head, true).unwrap();
        repo.set_head(&format!("refs/heads/{branch}")).unwrap();
        commit(dir, repo, files, "agent");
        repo.set_head(&work).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    }

    fn tip(repo: &Repository, branch: &str) -> String {
        repo.find_branch(branch, BranchType::Local)
            .unwrap()
            .get()
            .target()
            .unwrap()
            .to_string()
    }

    const BASE: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
    const THEIRS: &str = "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n";

    fn accept(index: usize) -> HunkDecision {
        HunkDecision {
            index,
            accept: true,
            text: None,
        }
    }

    fn note(path: &str, hunks: Vec<HunkDecision>) -> NoteDecision {
        NoteDecision {
            path: path.into(),
            accepted: false,
            hunks,
            resolve: None,
        }
    }

    fn finish(
        dir: &Path,
        repo: &Repository,
        d: &[NoteDecision],
        delete: bool,
    ) -> Result<ReviewOutcome, String> {
        review_finish(
            dir,
            "claude/x",
            &tip(repo, "claude/x"),
            d,
            delete,
            None,
            &MemoryStore::default(),
        )
    }

    #[test]
    fn hunks_list_the_changed_blocks_of_a_note() {
        let (dir, repo) = init("hunks");
        commit(&dir, &repo, &[("a.md", Some(BASE))], "init");
        on_branch(&dir, &repo, "claude/x", &[("a.md", Some(THEIRS))]);
        let h = review_hunks(&dir, &tip(&repo, "claude/x"), "a.md").unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].old.as_str(), h[0].new.as_str()), ("one\n", "ONE\n"));
        assert_eq!((h[0].old_start, h[0].old_lines), (0, 1));
        assert_eq!(
            (h[1].old.as_str(), h[1].new.as_str()),
            ("seven\n", "SEVEN\n")
        );
        assert_eq!(h[1].old_start, 6);
    }

    #[test]
    fn partial_acceptance_commits_only_the_accepted_hunks() {
        let (dir, repo) = init("partial");
        commit(
            &dir,
            &repo,
            &[("a.md", Some(BASE)), ("b.md", Some("b"))],
            "init",
        );
        on_branch(
            &dir,
            &repo,
            "claude/x",
            &[
                ("a.md", Some(THEIRS)),
                ("b.md", Some("b2")),
                ("c.md", Some("new")),
            ],
        );
        let before = repo.head().unwrap().target().unwrap();
        let out = finish(
            &dir,
            &repo,
            &[
                note("a.md", vec![accept(1)]),
                note("b.md", vec![]),
                NoteDecision {
                    accepted: true,
                    ..note("c.md", vec![accept(0)])
                },
            ],
            false,
        )
        .unwrap();
        assert!(out.conflicts.is_empty());
        assert_eq!(out.applied, vec!["a.md", "c.md"]);
        assert_eq!(
            fs::read_to_string(dir.join("a.md")).unwrap(),
            "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n"
        );
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "b");
        assert_eq!(fs::read_to_string(dir.join("c.md")).unwrap(), "new");
        let commit = repo
            .find_commit(git2::Oid::from_str(&out.commit.unwrap()).unwrap())
            .unwrap();
        assert!(commit
            .message()
            .unwrap()
            .starts_with("review: accept changes from claude/x"));
        assert_eq!(commit.parent_id(0).unwrap(), before);
        assert_eq!(repo.head().unwrap().target().unwrap(), commit.id());
        // Branch kept when not asked to delete it.
        assert!(repo.find_branch("claude/x", BranchType::Local).is_ok());
    }

    #[test]
    fn an_accepted_hunk_can_be_edited_first() {
        let (dir, repo) = init("edit");
        commit(&dir, &repo, &[("a.md", Some(BASE))], "init");
        on_branch(&dir, &repo, "claude/x", &[("a.md", Some(THEIRS))]);
        let edited = HunkDecision {
            index: 0,
            accept: true,
            text: Some("Uno".into()),
        };
        finish(&dir, &repo, &[note("a.md", vec![edited])], false).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("a.md")).unwrap(),
            "Uno\ntwo\nthree\nfour\nfive\nsix\nseven\n"
        );
    }

    #[test]
    fn a_deleted_note_is_removed_when_accepted_and_kept_when_rejected() {
        let (dir, repo) = init("delete");
        commit(
            &dir,
            &repo,
            &[("a.md", Some("a\n")), ("b.md", Some("b\n"))],
            "init",
        );
        on_branch(&dir, &repo, "claude/x", &[("a.md", None), ("b.md", None)]);
        let out = finish(&dir, &repo, &[note("a.md", vec![accept(0)])], false).unwrap();
        assert_eq!(out.applied, vec!["a.md"]);
        assert!(!dir.join("a.md").exists());
        assert!(dir.join("b.md").exists());
        assert!(repo
            .head()
            .unwrap()
            .peel_to_tree()
            .unwrap()
            .get_name("a.md")
            .is_none());
    }

    #[test]
    fn changes_made_in_the_vault_meanwhile_are_merged() {
        let (dir, repo) = init("merge");
        commit(&dir, &repo, &[("a.md", Some(BASE))], "init");
        on_branch(&dir, &repo, "claude/x", &[("a.md", Some(THEIRS))]);
        // The user edited the middle of the note on the working branch.
        commit(
            &dir,
            &repo,
            &[("a.md", Some("one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n"))],
            "mine",
        );
        let out = finish(
            &dir,
            &repo,
            &[note("a.md", vec![accept(0), accept(1)])],
            false,
        )
        .unwrap();
        assert!(out.conflicts.is_empty(), "{out:?}");
        assert_eq!(
            fs::read_to_string(dir.join("a.md")).unwrap(),
            "ONE\ntwo\nthree\nFOUR\nfive\nsix\nSEVEN\n"
        );
    }

    #[test]
    fn a_note_that_no_longer_applies_cleanly_reports_both_versions_and_writes_nothing() {
        let (dir, repo) = init("conflict");
        commit(
            &dir,
            &repo,
            &[("a.md", Some(BASE)), ("b.md", Some("b\n"))],
            "init",
        );
        on_branch(
            &dir,
            &repo,
            "claude/x",
            &[("a.md", Some(THEIRS)), ("b.md", Some("b agent\n"))],
        );
        commit(
            &dir,
            &repo,
            &[("a.md", Some(&BASE.replace("one", "uno")))],
            "mine",
        );
        let head = repo.head().unwrap().target().unwrap();
        let decisions = vec![
            note("a.md", vec![accept(0), accept(1)]),
            note("b.md", vec![accept(0)]),
        ];
        let out = finish(&dir, &repo, &decisions, true).unwrap();
        assert_eq!(out.conflicts.len(), 1);
        let c = &out.conflicts[0];
        assert_eq!(c.path, "a.md");
        assert_eq!(c.mine.as_deref(), Some(BASE.replace("one", "uno").as_str()));
        assert_eq!(c.branch.as_deref(), Some(THEIRS));
        // Nothing was written, committed or deleted, not even the clean note.
        assert_eq!(fs::read_to_string(dir.join("b.md")).unwrap(), "b\n");
        assert_eq!(repo.head().unwrap().target().unwrap(), head);
        assert!(repo.find_branch("claude/x", BranchType::Local).is_ok());

        // Keep mine for the conflict: the rest goes through.
        let mut decisions = decisions;
        decisions[0].resolve = Some(Resolve::Mine);
        let out = finish(&dir, &repo, &decisions, true).unwrap();
        assert!(out.conflicts.is_empty());
        assert_eq!(out.applied, vec!["b.md"]);
        assert_eq!(
            fs::read_to_string(dir.join("a.md")).unwrap(),
            BASE.replace("one", "uno")
        );
    }

    #[test]
    fn the_branch_version_can_replace_a_conflicting_note() {
        let (dir, repo) = init("take-branch");
        commit(&dir, &repo, &[("a.md", Some(BASE))], "init");
        on_branch(&dir, &repo, "claude/x", &[("a.md", Some(THEIRS))]);
        commit(
            &dir,
            &repo,
            &[("a.md", Some(&BASE.replace("one", "uno")))],
            "mine",
        );
        let mut d = note("a.md", vec![accept(0), accept(1)]);
        d.resolve = Some(Resolve::Branch);
        finish(&dir, &repo, &[d], false).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), THEIRS);
    }

    #[test]
    fn a_note_deleted_in_the_vault_but_changed_by_the_branch_conflicts() {
        let (dir, repo) = init("deleted-mine");
        commit(
            &dir,
            &repo,
            &[("a.md", Some(BASE)), ("z.md", Some("z"))],
            "init",
        );
        on_branch(&dir, &repo, "claude/x", &[("a.md", Some(THEIRS))]);
        commit(&dir, &repo, &[("a.md", None)], "mine");
        let out = finish(&dir, &repo, &[note("a.md", vec![accept(0)])], false).unwrap();
        assert_eq!(out.conflicts.len(), 1);
        assert_eq!(out.conflicts[0].mine, None);
        assert!(!dir.join("a.md").exists());
    }

    #[test]
    fn rejecting_everything_changes_nothing_and_deletes_the_branch() {
        let (dir, repo) = init("reject");
        commit(&dir, &repo, &[("a.md", Some(BASE))], "init");
        on_branch(&dir, &repo, "claude/x", &[("a.md", Some(THEIRS))]);
        let head = repo.head().unwrap().target().unwrap();
        let out = finish(&dir, &repo, &[note("a.md", vec![])], true).unwrap();
        assert_eq!(out.commit, None);
        assert!(out.applied.is_empty());
        assert!(out.branch_deleted);
        assert_eq!(repo.head().unwrap().target().unwrap(), head);
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), BASE);
        assert!(repo.find_branch("claude/x", BranchType::Local).is_err());
    }

    #[test]
    fn finishing_deletes_the_branch_on_the_remote_too() {
        let bare = temp("remote-bare");
        Repository::init_bare(&bare).unwrap();
        let (dir, repo) = init("remote");
        repo.remote("origin", &format!("file://{}", bare.display()))
            .unwrap();
        commit(&dir, &repo, &[("a.md", Some(BASE))], "init");
        on_branch(&dir, &repo, "claude/x", &[("a.md", Some(THEIRS))]);
        repo.find_remote("origin")
            .unwrap()
            .push(&["refs/heads/claude/x:refs/heads/claude/x"], None)
            .unwrap();
        repo.reference(
            "refs/remotes/origin/claude/x",
            repo.refname_to_id("refs/heads/claude/x").unwrap(),
            true,
            "t",
        )
        .unwrap();
        let out = finish(
            &dir,
            &repo,
            &[note("a.md", vec![accept(0), accept(1)])],
            true,
        )
        .unwrap();
        assert_eq!(out.warning, None);
        assert!(out.branch_deleted);
        let remote = Repository::open_bare(&bare).unwrap();
        assert!(remote.find_reference("refs/heads/claude/x").is_err());
        assert!(repo.find_reference("refs/remotes/origin/claude/x").is_err());
        assert!(repo.find_branch("claude/x", BranchType::Local).is_err());
    }

    #[test]
    fn an_unreachable_remote_is_a_warning_not_a_failure() {
        let (dir, repo) = init("remote-gone");
        repo.remote("origin", "file:///nonexistent/nixe-remote")
            .unwrap();
        commit(&dir, &repo, &[("a.md", Some(BASE))], "init");
        on_branch(&dir, &repo, "claude/x", &[("a.md", Some(THEIRS))]);
        repo.reference(
            "refs/remotes/origin/claude/x",
            repo.refname_to_id("refs/heads/claude/x").unwrap(),
            true,
            "t",
        )
        .unwrap();
        let out = finish(
            &dir,
            &repo,
            &[note("a.md", vec![accept(0), accept(1)])],
            true,
        )
        .unwrap();
        assert!(out.commit.is_some());
        assert!(out.warning.is_some());
    }

    #[test]
    fn unfinished_decisions_are_saved_in_the_git_directory_and_survive_a_reopen() {
        let (dir, repo) = init("state");
        commit(&dir, &repo, &[("a.md", Some("a"))], "init");
        assert_eq!(review_state_load(&dir, "claude/x").unwrap(), None);
        review_state_save(&dir, "claude/x", Some("{\"tip\":\"t\"}")).unwrap();
        assert_eq!(
            review_state_load(&dir, "claude/x").unwrap().as_deref(),
            Some("{\"tip\":\"t\"}")
        );
        assert_eq!(review_state_load(&dir, "claude/y").unwrap(), None);
        // It is not part of the vault.
        assert!(!dir.join("nixe-review").exists());
        review_state_save(&dir, "claude/x", None).unwrap();
        assert_eq!(review_state_load(&dir, "claude/x").unwrap(), None);
    }

    #[test]
    fn finishing_clears_the_saved_state() {
        let (dir, repo) = init("state-clear");
        commit(&dir, &repo, &[("a.md", Some(BASE))], "init");
        on_branch(&dir, &repo, "claude/x", &[("a.md", Some(THEIRS))]);
        review_state_save(&dir, "claude/x", Some("{}")).unwrap();
        finish(&dir, &repo, &[note("a.md", vec![])], false).unwrap();
        assert_eq!(review_state_load(&dir, "claude/x").unwrap(), None);
    }
}
