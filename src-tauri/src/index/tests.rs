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
    assert_eq!(notes[0].aliases, ["Start"]);
    assert!(notes[1].aliases.is_empty());

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
fn related_ranks_by_closeness_and_says_why() {
    let (root, mut conn) = setup("related");
    write(
        &root,
        "Open.md",
        "#a #b #c\n[[Mutual]] [[Out]] [[Attach.png]]",
    );
    write(&root, "Mutual.md", "[[Open]]");
    write(&root, "Out.md", "text");
    write(&root, "Back.md", "[[Open]]");
    write(&root, "Hub.md", "# Hub\n[[Open]] [[Sibling]] [[Mutual]]");
    write(&root, "Hub2.md", "[[Open]] [[Sibling]]");
    write(&root, "Sibling.md", "text");
    write(&root, "Tagged.md", "#a #b");
    write(&root, "Tag1.md", "#c");
    write(&root, "Unrelated.md", "#z");
    run(&mut conn, &root);
    let rel = read::related(&conn, "Open.md").unwrap();
    let got: Vec<(&str, u32, Vec<&str>)> = rel
        .iter()
        .map(|r| {
            (
                r.path.as_str(),
                r.score,
                r.reasons.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            (
                "Mutual.md",
                115,
                vec!["links both ways", "both linked from Hub"]
            ),
            ("Back.md", 60, vec!["links here"]),
            ("Hub.md", 60, vec!["links here"]),
            ("Hub2.md", 60, vec!["links here"]),
            ("Out.md", 50, vec!["linked from here"]),
            ("Sibling.md", 30, vec!["both linked from Hub and 1 more"]),
            ("Tagged.md", 10, vec!["2 shared tags"]),
            ("Tag1.md", 5, vec!["1 shared tag"]),
        ]
    );
    assert!(read::related(&conn, "Missing.md").unwrap().is_empty());
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
    assert_eq!(
        (back[0].line, back[0].context.as_str()),
        (1, "[[Target]] and [[Target#Part|alias]] #shared #solo")
    );
    assert!(read::backlinks(&conn, "c.md").unwrap().is_empty());

    let tags = read::tags(&conn).unwrap();
    assert_eq!((tags[0].tag.as_str(), tags[0].count), ("shared", 2));
    assert!(tags.iter().any(|t| t.tag == "solo" && t.count == 1));
}

#[test]
fn unlinked_mentions_of_the_title_and_the_aliases() {
    let (root, mut conn) = setup("mentions");
    write(
        &root,
        "Target.md",
        "---\naliases: [Tgt]\n---\nTarget talks about target",
    );
    write(
        &root,
        "a.md",
        "intro\nI like the target and Tgt.\n[[Target]] `target`\n```\ntarget\n```\n",
    );
    write(
        &root,
        "sub/b.md",
        "no mention, only [[Target|target]] and [t](Target.md)",
    );
    run(&mut conn, &root);
    let found = read::unlinked_mentions(&conn, "Target.md").unwrap();
    assert_eq!(
        found
            .iter()
            .map(|m| (m.source.as_str(), m.line, m.text.as_str()))
            .collect::<Vec<_>>(),
        [("a.md", 2, "target"), ("a.md", 2, "Tgt")]
    );
    assert_eq!(found[0].context, "I like the target and Tgt.");
    assert_eq!(
        &"I like the target and Tgt."[found[1].start..found[1].end],
        "Tgt"
    );
    assert!(read::unlinked_mentions(&conn, "missing.md")
        .unwrap()
        .is_empty());
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
    // Switching a new file to WAL does not call the busy handler while other connections open it
    // (#207), so one round fails only now and then; many rounds make a regression certain.
    for round in 0..30 {
        let base = temp_dir(&format!("race-{round}"));
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

mod searching {
    use super::*;
    use crate::index::search::{parse_query, search};

    #[test]
    fn translates_words_phrases_and_operators() {
        let q = parse_query(r#"foo "exact phrase" tag:#Work path:notes/sub/ b"ar"#);
        assert_eq!(q.fts.as_deref(), Some(r#""foo"* "exact phrase" "bar"*"#));
        assert_eq!(q.tags, ["work"]);
        assert_eq!(q.paths, ["notes/sub/"]);
        assert_eq!(q.terms, ["foo", "exact phrase", "bar"]);
    }

    #[test]
    fn operators_take_a_quoted_operand_and_junk_is_dropped() {
        let q = parse_query(r#"tag:# "" - * path:"#);
        assert!(q.is_empty());
        assert_eq!(
            parse_query(r#"say "a""b""#).fts.as_deref(),
            Some(r#""say"* "a" "b""#)
        );
        assert!(parse_query("   ").is_empty());
    }

    #[test]
    fn fts_syntax_in_input_is_not_interpreted() {
        let q = parse_query("a OR b NEAR(c) col:x -d");
        assert_eq!(
            q.fts.as_deref(),
            Some(r#""a"* "OR"* "b"* "NEAR(c)"* "col:x"* "-d"*"#)
        );
    }

    fn vault(name: &str) -> (PathBuf, Connection) {
        let (root, mut conn) = setup(name);
        write(
            &root,
            "a.md",
            "# A\nthe quick brown fox\njumps over the lazy dog #animals",
        );
        write(
            &root,
            "work/b.md",
            "---\ntags: [work]\n---\nA quick note about quickly foxes",
        );
        write(&root, "work/deep/c.md", "lazy sunday #work/plans");
        write(&root, "other/d.md", "quick but not tagged. 100% sure_thing");
        run(&mut conn, &root);
        (root, conn)
    }

    fn paths(conn: &Connection, q: &str) -> Vec<String> {
        let mut p: Vec<String> = search(conn, q)
            .unwrap()
            .into_iter()
            .map(|h| h.path)
            .collect();
        p.sort();
        p
    }

    #[test]
    fn finds_words_by_prefix_and_phrases_exactly() {
        let (_r, conn) = vault("s-words");
        assert_eq!(paths(&conn, "quick"), ["a.md", "other/d.md", "work/b.md"]);
        assert_eq!(paths(&conn, "fo"), ["a.md", "work/b.md"]);
        assert_eq!(paths(&conn, r#""quick brown""#), ["a.md"]);
        assert!(paths(&conn, r#""brown quick""#).is_empty());
        assert!(search(&conn, "").unwrap().is_empty());
    }

    #[test]
    fn narrows_by_tag_including_nested_tags_and_by_path() {
        let (_r, conn) = vault("s-filter");
        assert_eq!(paths(&conn, "lazy tag:#work"), ["work/deep/c.md"]);
        assert_eq!(paths(&conn, "tag:#work"), ["work/b.md", "work/deep/c.md"]);
        assert_eq!(paths(&conn, "tag:work/plans"), ["work/deep/c.md"]);
        assert_eq!(paths(&conn, "tag:#wor"), Vec::<String>::new());
        assert_eq!(paths(&conn, "quick path:work/"), ["work/b.md"]);
        assert_eq!(
            paths(&conn, "lazy path:work/ tag:animals"),
            Vec::<String>::new()
        );
        assert_eq!(paths(&conn, "path:100%"), Vec::<String>::new());
    }

    #[test]
    fn hits_carry_highlighted_snippets_with_their_line() {
        let (_r, conn) = vault("s-snip");
        let hits = search(&conn, "lazy").unwrap();
        let a = hits.iter().find(|h| h.path == "a.md").unwrap();
        assert_eq!(a.title, "a");
        assert_eq!(a.snippets.len(), 1);
        assert_eq!(a.snippets[0].line, 3);
        assert!(a.snippets[0].text.contains("the \u{1}lazy\u{2} dog"));
        let hits = search(&conn, "quick").unwrap();
        let b = hits.iter().find(|h| h.path == "work/b.md").unwrap();
        assert!(b.snippets[0]
            .text
            .contains("\u{1}quick\u{2} note about \u{1}quickly\u{2}"));
        // A filter-only search lists notes without snippets.
        assert!(search(&conn, "tag:work").unwrap()[0].snippets.is_empty());
    }

    #[test]
    fn hits_count_all_matching_lines_beyond_the_snippets_shown() {
        let (root, mut conn) = setup("s-matches");
        write(
            &root,
            "many.md",
            "needle 1\nneedle 2\nneedle 3\nneedle 4\nneedle 5",
        );
        run(&mut conn, &root);
        let hit = &search(&conn, "needle").unwrap()[0];
        assert_eq!(hit.snippets.len(), 3);
        assert_eq!(hit.matches, 5);
        assert_eq!(search(&conn, "tag:none").unwrap().len(), 0);
    }

    #[test]
    fn hits_carry_the_modification_time_in_milliseconds() {
        let (_r, conn) = vault("s-mtime");
        let hits = search(&conn, "lazy").unwrap();
        // A file written just now: after 2020, not in nanoseconds.
        assert!(hits.iter().all(|h| h.modified > 1_577_836_800_000));
        assert!(hits.iter().all(|h| h.modified < 100_000_000_000_000));
    }

    #[test]
    fn long_lines_are_shortened_around_the_match() {
        let (root, mut conn) = setup("s-long");
        write(
            &root,
            "long.md",
            &format!("{} needle {}", "x ".repeat(200), "y ".repeat(200)),
        );
        run(&mut conn, &root);
        let s = &search(&conn, "needle").unwrap()[0].snippets[0];
        assert!(s.text.starts_with('…') && s.text.ends_with('…'));
        assert!(s.text.contains("\u{1}needle\u{2}"));
        assert!(s.text.chars().count() < 250);
    }

    #[test]
    fn searches_2000_notes_quickly() {
        let (root, mut conn) = setup("s-perf");
        for i in 0..2000 {
            write(
                &root,
                &format!("d{}/n{i}.md", i % 20),
                &format!("note {i} common words alpha{} #t{}", i % 50, i % 7),
            );
        }
        run(&mut conn, &root);
        for q in [
            "common",
            "alpha7 tag:t3",
            "\"common words\" path:d3/",
            "tag:t1",
        ] {
            let start = Instant::now();
            let hits = search(&conn, q).unwrap();
            assert!(!hits.is_empty(), "{q}");
            assert!(
                start.elapsed().as_millis() < 100,
                "{q}: {:?}",
                start.elapsed()
            );
        }
    }
}

#[test]
fn notes_by_property_matches_scalars_and_list_members() {
    let (root, mut conn) = setup("by-property");
    write(
        &root,
        "a.md",
        "---\nstatus: Done\nlist: [x, y]\nn: 3\n---\n",
    );
    write(&root, "b.md", "---\nstatus: open\n---\n");
    write(&root, "c.md", "no frontmatter\n");
    run(&mut conn, &root);
    let paths = |key: &str, value: Option<&str>| -> Vec<String> {
        read::notes_by_property(&conn, key, value)
            .unwrap()
            .into_iter()
            .map(|m| m.path)
            .collect()
    };
    assert_eq!(paths("status", None), ["a.md", "b.md"]);
    assert_eq!(paths("STATUS", Some("done")), ["a.md"]);
    assert_eq!(paths("list", Some("y")), ["a.md"]);
    assert_eq!(paths("n", Some("3")), ["a.md"]);
    assert!(paths("list", Some("z")).is_empty());
    assert!(paths("missing", None).is_empty());
}

mod workspace_search {
    use super::*;
    use crate::index::search::{parse_query, search_roots, SearchRoot};

    fn root(name: &str, notes: &[(&str, &str)]) -> (PathBuf, Connection) {
        let (dir, mut conn) = setup(name);
        for (rel, text) in notes {
            write(&dir, rel, text);
        }
        run(&mut conn, &dir);
        (dir, conn)
    }

    fn roots<'a>(list: &'a [(&'a str, &'a str, &'a Connection)]) -> Vec<SearchRoot<'a>> {
        list.iter()
            .map(|(name, path, conn)| SearchRoot { name, path, conn })
            .collect()
    }

    #[test]
    fn root_operand_is_parsed_with_quotes() {
        assert_eq!(parse_query("x root:Wiki").roots, ["wiki"]);
        assert_eq!(parse_query(r#"x root:"My Wiki""#).roots, ["my wiki"]);
        assert_eq!(
            parse_query(r#"root:"My Wiki" x"#).fts.as_deref(),
            Some(r#""x"*"#)
        );
        assert!(parse_query("root:").is_empty());
        assert!(!parse_query("root:a").is_empty());
    }

    #[test]
    fn searches_all_roots_and_names_the_root_of_each_hit() {
        let (a, ca) = root(
            "ws-a",
            &[("One.md", "alpha shared\n"), ("Same.md", "shared")],
        );
        let (b, cb) = root(
            "ws-b",
            &[("Two.md", "beta shared\n"), ("Same.md", "shared")],
        );
        let (pa, pb) = (a.to_string_lossy(), b.to_string_lossy());
        let list = [("Notes", &*pa, &ca), ("Wiki", &*pb, &cb)];
        let hits = search_roots(&roots(&list), "shared").unwrap();
        let found: Vec<(&str, &str)> = hits
            .iter()
            .map(|h| (h.root.as_deref().unwrap(), h.path.as_str()))
            .collect();
        for expected in [
            ("Notes", "One.md"),
            ("Notes", "Same.md"),
            ("Wiki", "Two.md"),
            ("Wiki", "Same.md"),
        ] {
            assert!(found.contains(&expected), "{expected:?} in {found:?}");
        }
        assert_eq!(hits.len(), 4);
        let wiki = hits.iter().find(|h| h.path == "Two.md").unwrap();
        assert_eq!(wiki.root_path.as_deref(), Some(&*pb));
        assert_eq!(wiki.snippets[0].line, 1);
    }

    #[test]
    fn root_filter_keeps_the_named_roots_only() {
        let (a, ca) = root("ws-fa", &[("One.md", "shared")]);
        let (b, cb) = root("ws-fb", &[("Two.md", "shared")]);
        let (pa, pb) = (a.to_string_lossy(), b.to_string_lossy());
        let list = [("Notes", &*pa, &ca), ("My Wiki", &*pb, &cb)];
        let r = roots(&list);
        let only = |q: &str| -> Vec<String> {
            search_roots(&r, q)
                .unwrap()
                .into_iter()
                .map(|h| h.path)
                .collect()
        };
        assert_eq!(only("shared root:notes"), ["One.md"]);
        assert_eq!(only(r#"shared root:"my wiki""#), ["Two.md"]);
        assert_eq!(only("shared root:notes root:wiki").len(), 1);
        assert_eq!(only("root:Notes"), ["One.md"]);
        assert!(only("shared root:missing").is_empty());
    }

    #[test]
    fn the_better_match_wins_across_roots_and_hits_are_capped() {
        let many: Vec<(String, String)> = (0..60)
            .map(|i| (format!("n{i:02}.md"), "needle".to_string()))
            .collect();
        let refs: Vec<(&str, &str)> = many.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let (a, ca) = root("ws-ca", &refs);
        let (b, cb) = root("ws-cb", &[("Tiny.md", "needle needle needle")]);
        let (pa, pb) = (a.to_string_lossy(), b.to_string_lossy());
        let list = [("A", &*pa, &ca), ("B", &*pb, &cb)];
        let hits = search_roots(&roots(&list), "needle").unwrap();
        assert_eq!(hits.len(), 50);
        assert!(hits.iter().any(|h| h.root.as_deref() == Some("B")));
    }

    #[test]
    fn ten_roots_with_5000_notes_answer_within_150_ms() {
        let mut keep = Vec::new();
        for r in 0..10 {
            let notes: Vec<(String, String)> = (0..500)
                .map(|i| {
                    (
                        format!("dir{}/note-{i}.md", i % 10),
                        format!(
                            "# Note {i}\n\nalpha{i} beta gamma delta word{} shared text\n",
                            i % 7
                        ),
                    )
                })
                .collect();
            let refs: Vec<(&str, &str)> = notes
                .iter()
                .map(|(a, b)| (a.as_str(), b.as_str()))
                .collect();
            keep.push(root(&format!("ws-perf{r}"), &refs));
        }
        let names: Vec<String> = (0..10).map(|i| format!("Root {i}")).collect();
        let paths: Vec<String> = keep
            .iter()
            .map(|(p, _)| p.to_string_lossy().into_owned())
            .collect();
        let list: Vec<(&str, &str, &Connection)> = keep
            .iter()
            .enumerate()
            .map(|(i, (_, c))| (names[i].as_str(), paths[i].as_str(), c))
            .collect();
        let r = roots(&list);
        for query in ["shared", "word3 gamma", "alpha42", "tag:#none shared"] {
            let start = Instant::now();
            let hits = search_roots(&r, query).unwrap();
            let took = start.elapsed();
            assert!(
                took.as_millis() < 150,
                "`{query}` took {took:?} for {} hits",
                hits.len()
            );
        }
        assert_eq!(search_roots(&r, "shared").unwrap().len(), 50);
    }
}

#[test]
fn a_root_operand_alone_selects_nothing_in_a_single_vault() {
    let (root, mut conn) = setup("root-alone");
    write(&root, "A.md", "text");
    run(&mut conn, &root);
    assert!(crate::index::search::search(&conn, "root:Wiki")
        .unwrap()
        .is_empty());
}
