use std::fs;

use serde_json::json;

use super::*;
use crate::index;
use crate::test_dir::TestDir;

/// A scanned index of a small vault; the directory must outlive the connection.
fn indexed() -> (TestDir, Connection) {
    let dir = TestDir::new("nixe-bases-");
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("books")).unwrap();
    fs::write(
        vault.join("books/Dune.md"),
        "---\nStatus: read\nrating: 5\nowned: true\nfinished: 2026-01-02\ntags: [book, scifi]\n---\n# Dune\n",
    )
    .unwrap();
    fs::write(vault.join("Empty.md"), "no frontmatter\n").unwrap();
    fs::write(vault.join("Library.base"), "views:\n  - type: table\n").unwrap();
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    (dir, conn)
}

fn cell(kind: &str, value: serde_json::Value) -> BaseCell {
    BaseCell {
        kind: Some(kind.into()),
        value,
    }
}

fn ids(result: &BaseResult) -> Vec<&str> {
    result.columns.iter().map(|c| c.id.as_str()).collect()
}

#[test]
fn the_base_of_the_fixture_vault_shows_its_notes() {
    let dir = TestDir::new("nixe-bases-fixture-");
    let vault = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/vault");
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    let source = fs::read_to_string(vault.join("Notes.base")).unwrap();

    let result = query(&conn, &source, None).unwrap();

    assert!(result.unsupported.is_empty());
    let labels: Vec<&str> = result.columns.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "file.name",
            "Title",
            "Count",
            "published",
            "created",
            "tags"
        ]
    );
    let meta = result.rows.iter().find(|r| r.path == "Meta.md").unwrap();
    assert_eq!(meta.cells[2], cell("number", json!(3)));
    // Only the notes with the tag of the filter.
    let tagged = index::read::notes_filtered(&conn, &["project/nixe".into()], "").unwrap();
    let paths: Vec<&str> = result.rows.iter().map(|r| r.path.as_str()).collect();
    let wanted: Vec<&str> = tagged.iter().map(|n| n.path.as_str()).collect();
    assert_eq!(paths, wanted);
    assert!(paths.len() < index::read::note_count(&conn).unwrap());
}

#[test]
fn without_order_every_note_is_a_row_with_its_name() {
    let (_dir, conn) = indexed();
    let result = query(&conn, "views:\n  - type: table\n    name: All\n", None).unwrap();
    assert_eq!(result.view.as_deref(), Some("All"));
    assert_eq!(ids(&result), ["file.name"]);
    let rows: Vec<(&str, &BaseCell)> = result
        .rows
        .iter()
        .map(|r| (r.path.as_str(), &r.cells[0]))
        .collect();
    assert_eq!(
        rows,
        [
            ("Empty.md", &cell("text", json!("Empty"))),
            ("books/Dune.md", &cell("text", json!("Dune"))),
        ]
    );
    assert!(result.unsupported.is_empty());
}

#[test]
fn columns_follow_the_order_with_typed_values_and_display_names() {
    let (_dir, conn) = indexed();
    let source = r#"
properties:
  note.status: { displayName: State }
  rating: { displayName: Stars }
views:
  - type: table
    order:
      - status
      - file.name
      - note.rating
      - note["owned"]
      - finished
      - tags
      - missing
"#;
    let result = query(&conn, source, None).unwrap();
    let labels: Vec<&str> = result.columns.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "State",
            "file.name",
            "Stars",
            "owned",
            "finished",
            "tags",
            "missing"
        ]
    );
    assert_eq!(
        result.rows[1].cells,
        [
            cell("text", json!("read")),
            cell("text", json!("Dune")),
            cell("number", json!(5)),
            cell("checkbox", json!(true)),
            cell("date", json!("2026-01-02")),
            cell("list", json!(["book", "scifi"])),
            BaseCell::default(),
        ]
    );
    assert_eq!(result.rows[0].cells[0], BaseCell::default());
}

#[test]
fn unsupported_parts_are_named_and_not_applied() {
    let (_dir, conn) = indexed();
    let source = r#"
formulas: { double: rating * 2 }
views:
  - type: table
    limit: 1
    order: [formula.double, file.unknown, rating]
"#;
    let result = query(&conn, source, None).unwrap();
    assert_eq!(
        result.unsupported,
        [
            "formulas",
            "limit",
            "column formula.double",
            "column file.unknown"
        ]
    );
    assert_eq!(ids(&result), ["rating"]);
    assert_eq!(result.rows.len(), 2);
}

#[test]
fn a_view_with_unsupported_columns_only_shows_the_name() {
    let (_dir, conn) = indexed();
    let source = "views:\n  - type: table\n    order: [formula.x]\n";
    let result = query(&conn, source, None).unwrap();
    assert_eq!(ids(&result), ["file.name"]);
    assert_eq!(result.unsupported, ["column formula.x"]);
}

/// A vault with links, embeds, tags and folders; the directory must outlive the connection.
fn library() -> (TestDir, Connection) {
    let dir = TestDir::new("nixe-bases-filters-");
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("books/old")).unwrap();
    fs::create_dir_all(vault.join("booksellers")).unwrap();
    for (path, text) in [
        (
            "books/Dune.md",
            "---\nstatus: read\nrating: 5\nowned: true\nfinished: 2026-01-02\nmy price: 12\n\
             authors: [Frank, Brian]\n---\n#Book/SciFi [[Emma]] [[Emma|again]] [[Ghost]] \
             ![[cover.png]] [[#Top]]\n",
        ),
        (
            "books/old/Emma.md",
            "---\nstatus: open\nrating: 3\nowned: false\ntags: [book, classic]\n---\n[Dune](books/Dune.md)\n",
        ),
        ("booksellers/Shop.md", "![[Dune]]\n"),
        ("Home.md", "---\nrating: high\n---\n#bookshelf\n"),
        ("cover.png", "png"),
    ] {
        fs::write(vault.join(path), text).unwrap();
    }
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    (dir, conn)
}

const DUNE: &str = "books/Dune.md";
const EMMA: &str = "books/old/Emma.md";
const HOME: &str = "Home.md";
const SHOP: &str = "booksellers/Shop.md";
const ALL: [&str; 4] = [HOME, DUNE, EMMA, SHOP];

fn paths(conn: &Connection, source: &str) -> Vec<String> {
    let result = query(conn, source, None).unwrap_or_else(|e| panic!("{source}: {e}"));
    assert!(result.unsupported.is_empty(), "{source}");
    result.rows.into_iter().map(|r| r.path).collect()
}

/// A base whose view filters by one expression.
fn filtered(expression: &str) -> String {
    let quoted = serde_json::to_string(expression).unwrap();
    format!("views:\n  - type: table\n    filters: {quoted}\n")
}

#[track_caller]
fn assert_matches(conn: &Connection, cases: &[(&str, &[&str])]) {
    for (expression, wanted) in cases {
        assert_eq!(&paths(conn, &filtered(expression)), wanted, "{expression}");
    }
}

#[test]
fn the_global_filters_and_those_of_the_view_both_apply() {
    let (_dir, conn) = library();
    let source = r#"
filters: file.inFolder("books")
views:
  - type: table
    name: Read
    filters: status == "read"
  - type: table
    name: All
  - type: table
    name: Broken
    filters: status ==
"#;
    let rows = |view: &str| {
        let result = query(&conn, source, Some(view)).unwrap();
        result.rows.into_iter().map(|r| r.path).collect::<Vec<_>>()
    };
    assert_eq!(rows("Read"), [DUNE]);
    assert_eq!(rows("All"), [DUNE, EMMA]);
    // The filters of another view are not read.
    assert!(query(&conn, source, Some("Broken")).is_err());
}

#[test]
fn and_or_and_not_nest() {
    let (_dir, conn) = library();
    let source = r#"
filters:
  or:
    - file.name == "Home.md"
    - and:
        - file.hasTag("book")
        - not:
            - status == "open"
            - or:
                - rating < 4
views:
  - type: table
"#;
    assert_eq!(paths(&conn, source), [HOME, DUNE]);
    let group = |filters: &str| format!("filters: {filters}\nviews:\n  - type: table\n");
    // `not` holds when no entry does.
    assert_eq!(
        paths(&conn, &group("{ not: [rating == 5, rating == 3] }")),
        [HOME, SHOP]
    );
    assert_eq!(paths(&conn, &group("{ and: [owned, rating > 4] }")), [DUNE]);
    assert_eq!(
        paths(&conn, &group("{ or: [rating == 5, rating == 3] }")),
        [DUNE, EMMA]
    );
    for empty in ["{}", "[]", "''", "{ and: [] }", "{ or: }", "{ not: [] }"] {
        assert_eq!(paths(&conn, &group(empty)), ALL, "{empty}");
    }
}

#[test]
fn operators_and_literals() {
    let (_dir, conn) = library();
    assert_matches(
        &conn,
        &[
            ("rating + 1 == 6", &[DUNE]),
            ("rating - 1 == 2", &[EMMA]),
            ("rating * 2 >= 6", &[DUNE, EMMA]),
            ("rating / 2 == 2.5", &[DUNE]),
            ("rating % 2 == 1", &[DUNE, EMMA]),
            ("-rating < -4", &[DUNE]),
            ("(rating + 1) * 2 == 8", &[EMMA]),
            ("status + \"!\" == 'read!'", &[DUNE]),
            ("rating <= 3", &[EMMA]),
            // Missing and non-numeric values are in no order, and unequal to everything.
            ("rating > 0", &[DUNE, EMMA]),
            ("status != \"read\"", &[HOME, EMMA, SHOP]),
            ("!status", &[HOME, SHOP]),
            ("rating / 0 > 0", &[]),
            ("rating == \"5\"", &[]),
            ("owned == true", &[DUNE]),
            ("owned == false", &[EMMA]),
            ("owned && rating == 5", &[DUNE]),
            ("owned || rating == 3", &[DUNE, EMMA]),
            ("!(owned || rating == 3)", &[HOME, SHOP]),
            ("authors == [\"Frank\", 'Brian']", &[DUNE]),
            ("authors != []", &ALL),
            (
                "finished > \"2026-01-01\" && finished < '2026-01-03'",
                &[DUNE],
            ),
            ("note[\"my price\"] == 12", &[DUNE]),
            ("note.status == \"open\"", &[EMMA]),
            ("Status == \"open\"", &[EMMA]),
            ("true", &ALL),
            ("false", &[]),
        ],
    );
}

#[test]
fn file_fields() {
    let (_dir, conn) = library();
    assert_matches(
        &conn,
        &[
            ("file.name == \"Dune.md\"", &[DUNE]),
            ("file.basename == \"Dune\"", &[DUNE]),
            ("file.path == \"books/old/Emma.md\"", &[EMMA]),
            ("file.folder == \"books\"", &[DUNE]),
            ("file.folder == \"\"", &[HOME]),
            ("file.ext == \"md\"", &ALL),
            ("file.size == 10", &[SHOP]),
            ("file.mtime > \"2000-01-01\"", &ALL),
            ("file.mtime < \"2000-01-01 12:00\"", &[]),
            ("file.ctime > \"2000-01-01T00:00:00Z\"", &ALL),
            ("file.ctime <= file.mtime || file.ctime > file.mtime", &ALL),
            ("file.tags == [\"book\", \"classic\"]", &[EMMA]),
            ("file.links == [\"books/old/Emma.md\", \"Ghost\"]", &[DUNE]),
            ("file.embeds == [\"cover.png\"]", &[DUNE]),
            ("file.embeds == [\"books/Dune.md\"]", &[SHOP]),
            ("file.backlinks == [\"books/Dune.md\"]", &[EMMA]),
            ("file.backlinks", &[DUNE, EMMA]),
            ("file.properties", &[HOME, DUNE, EMMA]),
        ],
    );
}

#[test]
fn file_functions() {
    let (_dir, conn) = library();
    assert_matches(
        &conn,
        &[
            // Nested tags count, a longer name does not.
            ("file.hasTag(\"book\")", &[DUNE, EMMA]),
            ("file.hasTag(\"#BOOK/scifi\")", &[DUNE]),
            ("file.hasTag(\"classic\", \"bookshelf\")", &[HOME, EMMA]),
            ("file.hasTag(\"\")", &[]),
            ("file.inFolder(\"books\")", &[DUNE, EMMA]),
            ("file.inFolder(\"/books/old/\")", &[EMMA]),
            ("file.inFolder(\"\")", &ALL),
            ("file.hasLink(\"Emma\")", &[DUNE]),
            ("file.hasLink(\"[[books/Dune|x]]\")", &[EMMA, SHOP]),
            ("file.hasLink(\"cover.png\")", &[DUNE]),
            ("file.hasLink(\"ghost\")", &[DUNE]),
            ("file.hasLink(\"Nobody\")", &[]),
            ("file.hasProperty(\"Owned\")", &[DUNE, EMMA]),
            ("file.hasProperty(\"missing\")", &[]),
            ("!file.hasProperty(\"rating\")", &[SHOP]),
        ],
    );
}

#[test]
fn file_fields_are_columns() {
    let (_dir, conn) = library();
    let source = r#"
properties:
  file.size: { displayName: Bytes }
filters: file.name == "Emma.md"
views:
  - type: table
    order: [file.name, file.basename, file.path, file.folder, file.ext, file.size, file.ctime,
            file.mtime, file.tags, file.links, file.embeds, file.backlinks, file.properties]
"#;
    let result = query(&conn, source, None).unwrap();
    assert!(result.unsupported.is_empty());
    assert_eq!(result.columns[0].label, "file.name");
    assert_eq!(result.columns[5].label, "Bytes");
    assert_eq!(result.columns[12].label, "file.properties");
    let cells = &result.rows[0].cells;
    assert_eq!(cells[0], cell("text", json!("Emma")));
    assert_eq!(cells[1], cell("text", json!("Emma")));
    assert_eq!(cells[2], cell("text", json!(EMMA)));
    assert_eq!(cells[3], cell("text", json!("books/old")));
    assert_eq!(cells[4], cell("text", json!("md")));
    let size = fs::metadata(_dir.join("vault").join(EMMA)).unwrap().len();
    assert_eq!(cells[5], cell("number", json!(size)));
    for date in &cells[6..8] {
        assert_eq!(date.kind.as_deref(), Some("date"));
        let text = date.value.as_str().unwrap();
        chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S").unwrap();
    }
    assert_eq!(cells[8], cell("list", json!(["book", "classic"])));
    assert_eq!(cells[9], cell("list", json!([DUNE])));
    assert_eq!(cells[10], cell("list", json!([])));
    assert_eq!(cells[11], cell("list", json!([DUNE])));
    assert_eq!(
        cells[12],
        cell(
            "list",
            json!([
                "status: open",
                "rating: 3",
                "owned: false",
                "tags: [\"book\",\"classic\"]"
            ])
        )
    );
}

#[test]
fn a_broken_filter_names_the_expression_and_shows_no_rows() {
    let (_dir, conn) = library();
    for (source, wanted) in [
        (
            "filters: rating >",
            "Invalid filters: syntax error: unexpected end in `rating >`.",
        ),
        (
            "filters: { and: ['true', { not: [file.hasTags(\"a\")] }] }",
            "Invalid filters: unknown function `file.hasTags` in `file.hasTags(\"a\")`.",
        ),
        (
            // No short circuit hides an error.
            "filters: false && today() > 1",
            "Invalid filters: unknown function `today` in `false && today() > 1`.",
        ),
        (
            "filters: { xor: [true] }",
            "Invalid filters: unknown key `xor`; use `and`, `or` or `not`.",
        ),
        (
            "filters: { and: true }",
            "Invalid filters: `and` needs a list, found `true`.",
        ),
        ("filters: { and: [true], or: [true] }", "found `and:"),
        ("filters: { and: [5] }", "found `5`."),
        ("filters: [true]", "expected an expression"),
        ("filters: !done", "expected an expression"),
    ] {
        let base = format!("{source}\nviews:\n  - type: table\n");
        let error = query(&conn, &base, None).unwrap_err();
        assert!(error.contains(wanted), "{source}: {error}");
    }
    let error = query(&conn, &filtered("nope()"), None).unwrap_err();
    assert_eq!(
        error,
        "Invalid view filters: unknown function `nope` in `nope()`."
    );
}

#[test]
fn the_first_table_view_or_the_named_one_is_shown() {
    let (_dir, conn) = indexed();
    let source = "views:\n  - { type: cards, name: C }\n  - { type: table, name: A }\n  - { type: table, name: B }\n";
    assert_eq!(
        query(&conn, source, None).unwrap().view.as_deref(),
        Some("A")
    );
    assert_eq!(
        query(&conn, source, Some("B")).unwrap().view.as_deref(),
        Some("B")
    );
    let cards = query(&conn, source, Some("C")).unwrap_err();
    assert!(cards.contains("\"cards\" are not supported"), "{cards}");
    let missing = query(&conn, source, Some("D")).unwrap_err();
    assert!(missing.contains("no view named \"D\""), "{missing}");
}

#[test]
fn a_base_without_a_table_view_and_invalid_yaml_are_errors() {
    let (_dir, conn) = indexed();
    let list = query(&conn, "views:\n  - type: list\n", None).unwrap_err();
    assert!(list.contains("\"list\""), "{list}");
    assert_eq!(
        query(&conn, "", None).unwrap_err(),
        "The base defines no view."
    );
    assert!(query(&conn, "views: [", None)
        .unwrap_err()
        .starts_with("Invalid YAML"));
}
