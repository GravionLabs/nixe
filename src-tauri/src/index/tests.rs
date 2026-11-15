use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rusqlite::Connection;

use super::scan::ScanSummary;
use super::*;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nixe-index-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dunce::canonicalize(dir).unwrap()
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// A vault and an index database next to it (outside the vault).
fn setup(name: &str) -> (PathBuf, Connection) {
    let base = temp_dir(name);
    let root = base.join("vault");
    fs::create_dir_all(&root).unwrap();
    let conn = open(&base.join("index/v.sqlite")).unwrap();
    (root, conn)
}

fn run(conn: &mut Connection, root: &Path) -> ScanSummary {
    scan(conn, root, |_| {}).unwrap()
}

fn tables(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap();
    stmt.query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn creates_the_versioned_schema() {
    let (_, conn) = setup("schema");
    let names = tables(&conn);
    for t in [
        "notes",
        "links",
        "tags",
        "headings",
        "properties",
        "notes_fts",
    ] {
        assert!(names.iter().any(|n| n == t), "missing table {t}");
    }
    let v: i32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(v, SCHEMA_VERSION);
}

#[test]
fn a_version_bump_rebuilds_the_index() {
    let base = temp_dir("bump");
    let root = base.join("vault");
    write(&root, "a.md", "# A");
    let db = base.join("index/v.sqlite");
    {
        let mut conn = open(&db).unwrap();
        run(&mut conn, &root);
        assert_eq!(read::notes(&conn).unwrap().len(), 1);
        conn.pragma_update(None, "user_version", SCHEMA_VERSION - 1)
            .unwrap();
    }
    let conn = open(&db).unwrap();
    assert!(read::notes(&conn).unwrap().is_empty());
    let v: i32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(v, SCHEMA_VERSION);
}

#[test]
fn a_corrupt_file_is_replaced() {
    let base = temp_dir("corrupt");
    let db = base.join("index/v.sqlite");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    fs::write(
        &db,
        "this is not a database, but long enough to be read as one".repeat(50),
    )
    .unwrap();
    let conn = open(&db).unwrap();
    assert!(tables(&conn).contains(&"notes".to_string()));
}

#[test]
fn the_index_path_depends_on_the_vault() {
    let data = Path::new("/data");
    let a = index_path(data, Path::new("/vaults/a"));
    assert_eq!(a, index_path(data, Path::new("/vaults/a")));
    assert_ne!(a, index_path(data, Path::new("/vaults/b")));
    assert_eq!(a.parent().unwrap(), Path::new("/data/index"));
    assert_eq!(a.extension().unwrap(), "sqlite");
}

#[test]
fn indexes_notes_with_all_their_metadata() {
    let (root, mut conn) = setup("full");
    write(
        &root,
        "Home.md",
        "---\ntags: [project]\naliases: [Start]\nstatus: open\ncount: 3\ndone: true\n---\n# Title\n\nSee [[Other]] and ![[img.png]] #inline\n\n## Sub\n[md](Other.md)\n",
    );
    write(&root, "dir/Other.md", "other note");
    write(&root, "img.png", "png");
    let summary = run(&mut conn, &root);
    assert_eq!(summary.extracted, 2);

    let notes = read::notes(&conn).unwrap();
    assert_eq!(
        notes.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(),
        ["Home.md", "dir/Other.md"]
    );
    assert_eq!(notes[1].title, "Other");

    let meta = read::note_meta(&conn, "Home.md").unwrap().unwrap();
    assert_eq!(meta.aliases, ["Start"]);
    assert_eq!(meta.tags, ["project", "inline"]);
    assert_eq!(
        meta.headings
            .iter()
            .map(|h| (h.level, h.text.as_str()))
            .collect::<Vec<_>>(),
        [(1, "Title"), (2, "Sub")]
    );
    let kinds: Vec<(&str, &str, Option<&str>)> = meta
        .links
        .iter()
        .map(|l| (l.kind.as_str(), l.target.as_str(), l.resolved.as_deref()))
        .collect();
    assert_eq!(
        kinds,
        [
            ("link", "Other", Some("dir/Other.md")),
            ("embed", "img.png", Some("img.png")),
            ("markdown", "Other.md", Some("dir/Other.md")),
        ]
    );
    let prop = |k: &str| meta.properties.iter().find(|p| p.key == k).unwrap();
    assert_eq!(prop("status").kind, "text");
    assert_eq!(prop("count").kind, "number");
    assert_eq!(prop("count").value, serde_json::json!(3));
    assert_eq!(prop("done").kind, "checkbox");
    assert_eq!(prop("done").value, serde_json::json!(true));
    assert!(read::note_meta(&conn, "missing.md").unwrap().is_none());
}

#[test]
fn full_text_search_finds_bodies() {
    let (root, mut conn) = setup("fts");
    write(&root, "a.md", "the quick brown fox");
    write(&root, "b.md", "lazy dogs sleep");
    run(&mut conn, &root);
    let hits: Vec<String> = conn
        .prepare("SELECT n.path FROM notes_fts f JOIN notes n ON n.id = f.rowid WHERE notes_fts MATCH 'fox'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(hits, ["a.md"]);
}

#[test]
fn backlinks_and_tags() {
    let (root, mut conn) = setup("back");
    write(&root, "Target.md", "#shared\n[[#Self]] # Self");
    write(
        &root,
        "a.md",
        "[[Target]] and [[Target#Part|alias]] #shared #solo",
    );
    write(&root, "b.md", "![[Target]]");
    write(&root, "c.md", "[[Nowhere]]");
    run(&mut conn, &root);
    let back = read::backlinks(&conn, "Target.md").unwrap();
    assert_eq!(
        back.iter()
            .map(|b| (b.source.as_str(), b.kind.as_str()))
            .collect::<Vec<_>>(),
        [("a.md", "link"), ("a.md", "link"), ("b.md", "embed")]
    );
    assert_eq!(back[1].heading.as_deref(), Some("Part"));
    assert_eq!(back[1].alias.as_deref(), Some("alias"));
    assert!(read::backlinks(&conn, "c.md").unwrap().is_empty());

    let tags = read::tags(&conn).unwrap();
    assert_eq!((tags[0].tag.as_str(), tags[0].count), ("shared", 2));
    assert!(tags.iter().any(|t| t.tag == "solo" && t.count == 1));
}

#[test]
fn skips_internal_directories_and_ignored_files() {
    let (root, mut conn) = setup("skip");
    write(&root, "a.md", "a");
    write(&root, ".obsidian/x.md", "x");
    write(&root, ".git/y.md", "y");
    write(&root, ".trash/z.md", "z");
    write(&root, "build/out.md", "o");
    write(&root, ".gitignore", "build/\n");
    run(&mut conn, &root);
    let paths: Vec<String> = read::notes(&conn)
        .unwrap()
        .into_iter()
        .map(|n| n.path)
        .collect();
    assert_eq!(paths, ["a.md"]);
}

#[test]
fn a_rescan_extracts_only_what_changed() {
    let (root, mut conn) = setup("incr");
    write(&root, "a.md", "[[b]] #one");
    write(&root, "b.md", "b");
    write(&root, "c.md", "c");
    assert_eq!(run(&mut conn, &root).extracted, 3);
    assert_eq!(run(&mut conn, &root), ScanSummary::default());

    // Same size, newer mtime is a change; the extraction sees the new text.
    write(&root, "a.md", "[[c]] #two");
    let file = fs::File::options()
        .write(true)
        .open(root.join("a.md"))
        .unwrap();
    file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
        .unwrap();
    assert_eq!(run(&mut conn, &root).extracted, 1);
    let meta = read::note_meta(&conn, "a.md").unwrap().unwrap();
    assert_eq!(meta.tags, ["two"]);
    assert_eq!(meta.links[0].resolved.as_deref(), Some("c.md"));
    assert!(read::backlinks(&conn, "b.md").unwrap().is_empty());
    assert_eq!(read::backlinks(&conn, "c.md").unwrap().len(), 1);
}

#[test]
fn a_size_change_alone_is_detected() {
    let (root, mut conn) = setup("size");
    write(&root, "a.md", "one");
    run(&mut conn, &root);
    conn.execute("UPDATE files SET mtime_ns = 0, size = 1", [])
        .unwrap();
    assert_eq!(run(&mut conn, &root).extracted, 1);
}

#[test]
fn deleted_notes_leave_the_index_and_links_stop_resolving() {
    let (root, mut conn) = setup("delete");
    write(&root, "a.md", "[[b]] #t");
    write(&root, "b.md", "bee #t");
    run(&mut conn, &root);
    fs::remove_file(root.join("b.md")).unwrap();
    let summary = run(&mut conn, &root);
    assert_eq!((summary.extracted, summary.removed), (0, 1));
    assert_eq!(read::notes(&conn).unwrap().len(), 1);
    assert_eq!(
        read::note_meta(&conn, "a.md").unwrap().unwrap().links[0].resolved,
        None
    );
    assert_eq!(read::tags(&conn).unwrap()[0].count, 1);
    let fts: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fts, 1);
}

#[test]
fn a_new_note_resolves_links_that_were_dangling() {
    let (root, mut conn) = setup("late");
    write(&root, "a.md", "[[later]]");
    run(&mut conn, &root);
    write(&root, "later.md", "here");
    run(&mut conn, &root);
    let meta = read::note_meta(&conn, "a.md").unwrap().unwrap();
    assert_eq!(meta.links[0].resolved.as_deref(), Some("later.md"));
}

#[test]
fn reports_progress_and_writes_nothing_into_the_vault() {
    let (root, mut conn) = setup("progress");
    write(&root, "a.md", "a");
    write(&root, "b.md", "b");
    write(&root, "pic.png", "p");
    let before: Vec<_> = crate::vault::walk_vault(&root);
    let mut seen = Vec::new();
    scan(&mut conn, &root, |p| seen.push(p)).unwrap();
    assert_eq!(seen.first().map(|p| (p.done, p.total)), Some((0, 2)));
    assert_eq!(seen.last().map(|p| (p.done, p.total)), Some((2, 2)));
    assert_eq!(crate::vault::walk_vault(&root), before);
}

#[test]
fn scans_2000_notes_quickly() {
    let (root, mut conn) = setup("perf");
    for i in 0..2000 {
        write(
            &root,
            &format!("folder{}/note{i}.md", i % 20),
            &format!(
                "---\ntags: [t{}]\nstatus: open\n---\n# Note {i}\n\nLinks to [[note{}]] and [[note{}]] #tag{}\n\n## Part\n{}\n",
                i % 10,
                (i + 1) % 2000,
                (i + 7) % 2000,
                i % 30,
                "lorem ipsum dolor sit amet ".repeat(40)
            ),
        );
    }
    let start = Instant::now();
    assert_eq!(run(&mut conn, &root).extracted, 2000);
    let full = start.elapsed();
    let start = Instant::now();
    assert_eq!(run(&mut conn, &root), ScanSummary::default());
    let rescan = start.elapsed();
    eprintln!("full scan {full:?}, no-change rescan {rescan:?}");
    // The limits are 5 s and 500 ms; unoptimized test builds get generous headroom.
    let factor = if cfg!(debug_assertions) { 4 } else { 1 };
    assert!(full.as_millis() < 5000 * factor, "full scan took {full:?}");
    assert!(rescan.as_millis() < 500 * factor, "rescan took {rescan:?}");
}

#[test]
fn a_second_opener_during_creation_keeps_the_database() {
    let base = temp_dir("race");
    let db = base.join("index/v.sqlite");
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let db = db.clone();
            std::thread::spawn(move || {
                let conn = open(&db).unwrap();
                assert!(tables(&conn).contains(&"notes".to_string()));
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
}

#[test]
fn a_busy_database_is_not_deleted() {
    let base = temp_dir("busy");
    let db = base.join("index/v.sqlite");
    let mut first = open(&db).unwrap();
    let root = base.join("vault");
    write(&root, "a.md", "kept");
    run(&mut first, &root);
    // Opening again while the first connection holds a write transaction must not delete the file.
    let tx = first.transaction().unwrap();
    tx.execute("UPDATE files SET size = size", []).unwrap();
    let second = open(&db).unwrap();
    assert_eq!(read::notes(&second).unwrap().len(), 1);
    tx.commit().unwrap();
}

mod watching {
    use super::*;
    use crate::index::watch::{apply_changes, known_files, map_events, ChangeKind, VaultChange};

    fn events(root: &Path, conn: &Connection, rels: &[&str]) -> Vec<VaultChange> {
        let raw: Vec<PathBuf> = rels.iter().map(|r| root.join(r)).collect();
        map_events(root, &raw, &known_files(conn).unwrap())
    }

    fn kinds(changes: &[VaultChange]) -> Vec<(&str, ChangeKind)> {
        changes.iter().map(|c| (c.path.as_str(), c.kind)).collect()
    }

    #[test]
    fn maps_create_modify_and_remove_by_what_is_on_disk() {
        let (root, mut conn) = setup("map");
        write(&root, "keep.md", "one");
        write(&root, "gone.md", "two two");
        run(&mut conn, &root);
        write(&root, "keep.md", "changed text");
        write(&root, "new/fresh.md", "x");
        fs::remove_file(root.join("gone.md")).unwrap();
        let changes = events(&root, &conn, &["keep.md", "new/fresh.md", "gone.md"]);
        assert_eq!(
            kinds(&changes),
            [
                ("gone.md", ChangeKind::Remove),
                ("keep.md", ChangeKind::Modify),
                ("new/fresh.md", ChangeKind::Create)
            ]
        );
    }

    #[test]
    fn ignores_hidden_vault_folders_and_outside_paths() {
        let (root, conn) = setup("ignored");
        write(&root, ".git/x.md", "x");
        write(&root, ".obsidian/y.json", "y");
        let outside = root.parent().unwrap().join("other.md");
        fs::write(&outside, "z").unwrap();
        let raw = vec![
            root.join(".git/x.md"),
            root.join(".obsidian/y.json"),
            outside,
        ];
        assert!(map_events(&root, &raw, &known_files(&conn).unwrap()).is_empty());
    }

    #[test]
    fn a_moved_file_is_one_rename() {
        let (root, mut conn) = setup("rename");
        write(&root, "old.md", "same size");
        run(&mut conn, &root);
        fs::create_dir_all(root.join("dir")).unwrap();
        fs::rename(root.join("old.md"), root.join("dir/new.md")).unwrap();
        let changes = events(&root, &conn, &["old.md", "dir/new.md"]);
        assert_eq!(
            changes,
            [VaultChange {
                path: "dir/new.md".into(),
                kind: ChangeKind::Rename,
                from: Some("old.md".into())
            }]
        );
    }

    #[test]
    fn a_removed_folder_removes_its_files() {
        let (root, mut conn) = setup("rmdir");
        write(&root, "d/a.md", "a");
        write(&root, "d/b.md", "bb");
        run(&mut conn, &root);
        fs::remove_dir_all(root.join("d")).unwrap();
        let changes = events(&root, &conn, &["d"]);
        assert_eq!(
            kinds(&changes),
            [
                ("d/a.md", ChangeKind::Remove),
                ("d/b.md", ChangeKind::Remove)
            ]
        );
    }

    #[test]
    fn applies_changes_to_the_index_like_a_full_scan() {
        let (root, mut conn) = setup("apply");
        write(&root, "a.md", "see [[b]]");
        write(&root, "b.md", "# B");
        run(&mut conn, &root);
        assert_eq!(read::backlinks(&conn, "b.md").unwrap().len(), 1);

        // modify, create and remove at once
        write(&root, "a.md", "see [[c]] #tag");
        write(&root, "c.md", "# C note");
        fs::remove_file(root.join("b.md")).unwrap();
        let changes = events(&root, &conn, &["a.md", "c.md", "b.md"]);
        let summary = apply_changes(&mut conn, &root, &changes).unwrap();
        assert_eq!(summary.extracted, 2);
        assert_eq!(summary.removed, 1);
        assert!(read::note_meta(&conn, "b.md").unwrap().is_none());
        assert_eq!(read::backlinks(&conn, "c.md").unwrap()[0].source, "a.md");
        assert_eq!(
            read::note_meta(&conn, "a.md").unwrap().unwrap().tags,
            ["tag"]
        );

        // a full scan finds nothing left to do
        assert_eq!(run(&mut conn, &root), ScanSummary::default());
    }

    #[test]
    fn a_rename_moves_the_row_and_keeps_links_resolved() {
        let (root, mut conn) = setup("move");
        write(&root, "a.md", "link to [[note]]");
        write(&root, "note.md", "body text");
        run(&mut conn, &root);
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::rename(root.join("note.md"), root.join("sub/note.md")).unwrap();
        let changes = events(&root, &conn, &["note.md", "sub/note.md"]);
        apply_changes(&mut conn, &root, &changes).unwrap();
        assert!(read::note_meta(&conn, "note.md").unwrap().is_none());
        assert!(read::note_meta(&conn, "sub/note.md").unwrap().is_some());
        assert_eq!(read::backlinks(&conn, "sub/note.md").unwrap().len(), 1);
        assert_eq!(run(&mut conn, &root), ScanSummary::default());
    }
}
