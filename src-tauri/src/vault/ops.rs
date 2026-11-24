//! Structural operations as one Git commit each (#241): rename, move, delete, merge and
//! extract. In a Git vault the open changes are committed first, then the operation runs and
//! its changes are committed with a message that names it, so `git revert` undoes exactly it.
//! Without Git the operation just runs.

use std::path::Path;

use crate::git::{self, Identity};

/// `path` relative to the vault root with forward slashes, as it appears in a commit message.
pub fn display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// `, links in N notes` for N > 0.
pub fn links_suffix(notes: usize) -> String {
    match notes {
        0 => String::new(),
        1 => ", links in 1 note".into(),
        n => format!(", links in {n} notes"),
    }
}

/// `rename` when the folder stays, `move` when the note changes its folder.
pub fn rename_kind(from: &str, to: &str) -> &'static str {
    let dir = |p: &str| p.rsplit_once('/').map(|(d, _)| d.to_owned());
    if dir(from) == dir(to) {
        "rename"
    } else {
        "move"
    }
}

/// Runs `op` between a checkpoint and the commit of the operation. `describe` returns the kind
/// (`rename`, ...) and the first line of the message from the result of `op`.
pub fn commit_around<T>(
    root: &Path,
    reason: &str,
    fallback: Option<&Identity>,
    op: impl FnOnce() -> Result<T, String>,
    describe: impl FnOnce(&T) -> (&'static str, String),
) -> Result<T, String> {
    let git = git::checkpoint(root, reason, fallback)?;
    let done = op()?;
    if git {
        let (kind, summary) = describe(&done);
        // The operation is done: a failing commit must not hide it from the UI.
        if let Err(e) = git::commit_operation(root, kind, &summary, fallback) {
            log::warn!("the commit of the {kind} failed: {e}");
        }
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;
    use std::fs;

    fn repo(name: &str) -> TestDir {
        let dir = TestDir::new(&format!("nixe-ops-{name}-"));
        let r = git2::Repository::init(&dir).unwrap();
        let mut cfg = r.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@example.com").unwrap();
        dir
    }

    fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
        commit_around(
            root,
            "rename",
            None,
            || fs::rename(root.join(from), root.join(to)).map_err(|e| e.to_string()),
            |_| ("rename", format!("rename: {from} -> {to}")),
        )
    }

    fn log(root: &Path) -> Vec<String> {
        let r = git2::Repository::open(root).unwrap();
        let mut walk = r.revwalk().unwrap();
        walk.push_head().unwrap();
        walk.map(|o| {
            r.find_commit(o.unwrap())
                .unwrap()
                .summary()
                .unwrap()
                .unwrap_or("")
                .to_owned()
        })
        .collect()
    }

    #[test]
    fn formats_names_and_kinds() {
        let root = Path::new("/v");
        assert_eq!(display(root, Path::new("/v/a/b.md")), "a/b.md");
        assert_eq!(links_suffix(0), "");
        assert_eq!(links_suffix(1), ", links in 1 note");
        assert_eq!(links_suffix(9), ", links in 9 notes");
        assert_eq!(rename_kind("a/x.md", "a/y.md"), "rename");
        assert_eq!(rename_kind("a/x.md", "b/x.md"), "move");
        assert_eq!(rename_kind("x.md", "b/x.md"), "move");
    }

    #[test]
    fn an_operation_is_one_commit_after_the_open_edits() {
        let root = repo("commit");
        fs::write(root.join("a.md"), "one").unwrap();
        git::vault_commit(&root, Some("init"), None).unwrap();
        fs::write(root.join("a.md"), "edited").unwrap();
        rename(&root, "a.md", "b.md").unwrap();
        assert_eq!(
            log(&root),
            ["rename: a.md -> b.md", "checkpoint before rename", "init"]
        );
        let op = git::last_operation(&root).unwrap().unwrap();
        assert_eq!(op.kind, "rename");
        assert_eq!(op.message, "rename: a.md -> b.md");
        // The operation commit holds only the rename.
        let r = git2::Repository::open(&root).unwrap();
        let c = r.head().unwrap().peel_to_commit().unwrap();
        let diff = r
            .diff_tree_to_tree(
                Some(&c.parent(0).unwrap().tree().unwrap()),
                Some(&c.tree().unwrap()),
                None,
            )
            .unwrap();
        assert_eq!(diff.deltas().len(), 2);
    }

    #[test]
    fn undo_reverts_the_operation_also_after_later_edits() {
        let root = repo("undo");
        fs::write(root.join("a.md"), "one").unwrap();
        fs::write(root.join("c.md"), "other").unwrap();
        git::vault_commit(&root, Some("init"), None).unwrap();
        rename(&root, "a.md", "b.md").unwrap();
        fs::write(root.join("c.md"), "other, edited").unwrap();
        let undone = git::undo_operation(&root, None).unwrap();
        assert_eq!(undone.message, "rename: a.md -> b.md");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "one");
        assert!(!root.join("b.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("c.md")).unwrap(),
            "other, edited"
        );
        assert!(git::vault_status(&root)
            .unwrap()
            .unwrap()
            .changes
            .is_empty());
        // Undone once: nothing left to undo.
        assert!(git::last_operation(&root).unwrap().is_none());
        assert!(git::undo_operation(&root, None).is_err());
    }

    #[test]
    fn a_conflicting_undo_is_refused_and_changes_nothing() {
        let root = repo("conflict");
        fs::write(root.join("a.md"), "one").unwrap();
        git::vault_commit(&root, Some("init"), None).unwrap();
        rename(&root, "a.md", "b.md").unwrap();
        // A new note takes the old name: the revert would restore a.md over it.
        fs::write(root.join("a.md"), "new note").unwrap();
        git::vault_commit(&root, Some("later"), None).unwrap();
        let before = log(&root);
        let err = git::undo_operation(&root, None).unwrap_err();
        assert!(err.contains("nothing was changed"), "{err}");
        assert_eq!(log(&root), before);
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "new note");
        assert!(root.join("b.md").exists());
    }

    #[test]
    fn open_edits_are_committed_before_an_undo() {
        let root = repo("dirty");
        fs::write(root.join("a.md"), "one").unwrap();
        git::vault_commit(&root, Some("init"), None).unwrap();
        rename(&root, "a.md", "b.md").unwrap();
        fs::write(root.join("b.md"), "edited").unwrap();
        git::undo_operation(&root, None).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "edited");
        assert!(log(&root).contains(&"checkpoint before undo".to_string()));
    }

    #[test]
    fn without_git_the_operation_just_runs() {
        let dir = TestDir::new("nixe-ops-nogit-");
        fs::write(dir.join("a.md"), "x").unwrap();
        rename(&dir, "a.md", "b.md").unwrap();
        assert!(dir.join("b.md").exists());
        assert!(!dir.join(".git").exists());
        assert!(git::last_operation(&dir).unwrap().is_none());
        assert!(git::undo_operation(&dir, None).is_err());
    }

    #[test]
    fn a_failing_operation_writes_no_commit() {
        let root = repo("fail");
        fs::write(root.join("a.md"), "one").unwrap();
        git::vault_commit(&root, Some("init"), None).unwrap();
        assert!(rename(&root, "missing.md", "b.md").is_err());
        assert_eq!(log(&root), ["init"]);
    }

    #[test]
    fn history_entries_carry_their_operation() {
        let root = repo("history");
        fs::write(root.join("a.md"), "one").unwrap();
        git::vault_commit(&root, Some("init"), None).unwrap();
        rename(&root, "a.md", "b.md").unwrap();
        let h = git::note_history(&root, "b.md", 0, 10).unwrap();
        assert_eq!(h[0].operation.as_deref(), Some("rename"));
        assert_eq!(h[0].message, "rename: a.md -> b.md");
        assert_eq!(h[1].operation, None);
    }

    #[test]
    fn a_rename_moves_the_roles_in_the_same_commit_and_undo_restores_both() {
        use crate::vault::config;
        let root = repo("roles");
        fs::create_dir_all(root.join("In")).unwrap();
        fs::write(root.join("In/a.md"), "one").unwrap();
        fs::create_dir_all(root.join(".nixe")).unwrap();
        fs::write(
            root.join(config::SOURCE),
            "{\n  \"folders\": {\"inbox\": \"In\"}\n}",
        )
        .unwrap();
        git::vault_commit(&root, Some("init"), None).unwrap();
        commit_around(
            &root,
            "rename",
            None,
            || {
                fs::rename(root.join("In"), root.join("Eingang")).map_err(|e| e.to_string())?;
                config::rename_roles(&root, "In", "Eingang")
            },
            |_| ("rename", "rename: In -> Eingang".into()),
        )
        .unwrap();
        assert_eq!(log(&root), ["rename: In -> Eingang", "init"]);
        assert_eq!(
            config::Config::load(&root).role_folder("inbox").as_deref(),
            Some("Eingang")
        );
        assert!(git::vault_status(&root)
            .unwrap()
            .unwrap()
            .changes
            .is_empty());
        git::undo_operation(&root, None).unwrap();
        assert!(root.join("In/a.md").exists());
        assert_eq!(
            config::Config::load(&root).role_folder("inbox").as_deref(),
            Some("In")
        );
    }
}
