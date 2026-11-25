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
summaries: { custom: 'values.mean()' }
views:
  - type: table
    limit: 1
    order: [file.unknown, rating]
"#;
    let result = query(&conn, source, None).unwrap();
    assert_eq!(
        result.unsupported,
        ["summaries", "limit", "column file.unknown"]
    );
    assert_eq!(ids(&result), ["rating"]);
    assert_eq!(result.rows.len(), 2);
}

#[test]
fn a_view_with_unsupported_columns_only_shows_the_name() {
    let (_dir, conn) = indexed();
    let source = "views:\n  - type: table\n    order: [file.unknown]\n";
    let result = query(&conn, source, None).unwrap();
    assert_eq!(ids(&result), ["file.name"]);
    assert_eq!(result.unsupported, ["column file.unknown"]);
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

/// The cell of the formula `expression` for the note `path` of the library.
fn evaluated(conn: &Connection, path: &str, expression: &str) -> BaseCell {
    let source = serde_json::json!({
        "formulas": { "x": expression },
        "views": [{ "type": "table", "order": ["formula.x"] }],
    });
    let result = query(conn, &source.to_string(), None).unwrap();
    let row = result.rows.into_iter().find(|r| r.path == path).unwrap();
    row.cells.into_iter().next().unwrap()
}

#[track_caller]
fn assert_values(conn: &Connection, cases: &[(&str, serde_json::Value)]) {
    for (expression, wanted) in cases {
        let cell = evaluated(conn, DUNE, expression);
        assert_ne!(
            cell.kind.as_deref(),
            Some("error"),
            "{expression}: {}",
            cell.value
        );
        assert_eq!(&cell.value, wanted, "{expression}");
    }
}

#[test]
fn formulas_are_columns_and_use_each_other() {
    let (_dir, conn) = library();
    let source = r#"
formulas:
  label: 'status.title() + " " + formula.double'
  double: rating * 2
  "my flag": formula.double > 6
  status: '"formula"'
properties:
  formula.double: { displayName: Twice }
  status: { displayName: State }
views:
  - type: table
    order: [formula.double, formula.label, 'formula["my flag"]', formula.status, status]
"#;
    let result = query(&conn, source, None).unwrap();
    assert!(result.unsupported.is_empty());
    let labels: Vec<&str> = result.columns.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(labels, ["Twice", "label", "my flag", "status", "State"]);
    let row = |path: &str| &result.rows.iter().find(|r| r.path == path).unwrap().cells;
    assert_eq!(
        row(DUNE)[..],
        [
            cell("number", json!(10)),
            cell("text", json!("Read 10")),
            cell("checkbox", json!(true)),
            cell("text", json!("formula")),
            cell("text", json!("read")),
        ]
    );
    // A missing property gives no value, not an error.
    assert_eq!(row(SHOP)[0], BaseCell::default());
    assert_eq!(row(SHOP)[1], BaseCell::default());
}

#[test]
fn formulas_are_values_in_filters() {
    let (_dir, conn) = library();
    let base = |filter: &str| {
        let quoted = serde_json::to_string(filter).unwrap();
        format!(
            "formulas:\n  double: rating.toString() + rating.toString()\n  \
             big: formula.double == '55'\n  broken: 1 +\n\
             views:\n  - type: table\n    filters: {quoted}\n"
        )
    };
    assert_eq!(paths(&conn, &base("formula.big")), [DUNE]);
    assert_eq!(paths(&conn, &base("formula[\"double\"] == \"33\"")), [EMMA]);
    // A broken formula is an error where it is used, and only there.
    for (filter, wanted) in [
        (
            "formula.broken",
            "Invalid view filters: formula `broken`: syntax error: unexpected end in `1 +` in \
             `formula.broken`.",
        ),
        (
            "false && formula.nope",
            "Invalid view filters: unknown formula `nope` in `false && formula.nope`.",
        ),
    ] {
        assert_eq!(query(&conn, &base(filter), None).unwrap_err(), wanted);
    }
}

#[test]
fn a_cycle_is_an_error_in_its_column_and_in_filters() {
    let (_dir, conn) = library();
    let formulas = "formulas:\n  a: formula.b\n  b: formula.a\n  ok: '1'\n";
    let cycle = "the formulas form a cycle: `a` → `b` → `a`";
    let columns = format!(
        "{formulas}views:\n  - type: table\n    order: [formula.a, formula.ok, formula.nope]\n"
    );
    let result = query(&conn, &columns, None).unwrap();
    assert_eq!(result.rows.len(), 4);
    for row in &result.rows {
        assert_eq!(
            row.cells,
            [
                cell("error", json!(cycle)),
                cell("number", json!(1)),
                cell("error", json!("unknown formula `nope`")),
            ]
        );
    }
    let filtered = format!("{formulas}filters: formula.a\nviews:\n  - type: table\n");
    assert_eq!(
        query(&conn, &filtered, None).unwrap_err(),
        format!("Invalid filters: {cycle} in `formula.a`.")
    );
}

#[test]
fn an_error_in_a_cell_stays_in_it() {
    let (_dir, conn) = library();
    let source = r#"
formulas:
  number: number(rating)
  after: formula.number + 1
  guarded: if(rating.isType("number"), formula.number, 0)
views:
  - type: table
    order: [formula.number, formula.after, formula.guarded, file.name]
"#;
    let result = query(&conn, source, None).unwrap();
    let row = |path: &str| &result.rows.iter().find(|r| r.path == path).unwrap().cells;
    assert_eq!(result.rows.len(), 4);
    // `rating` of Home is the text "high".
    let error = cell("error", json!("`number` cannot read \"high\""));
    assert_eq!(
        row(HOME)[..3],
        [error.clone(), error, cell("number", json!(0))]
    );
    assert_eq!(row(HOME)[3], cell("text", json!("Home")));
    assert_eq!(row(DUNE)[1], cell("number", json!(6)));
}

#[test]
fn an_error_of_a_note_in_a_filter_names_it_and_shows_no_rows() {
    let (_dir, conn) = library();
    assert_eq!(
        query(&conn, &filtered("rating.abs() > 1"), None).unwrap_err(),
        "Error in view filters: `abs` is not available on a string in `rating.abs() > 1` for the \
         note `Home.md`."
    );
    // Guarded, the function is never called on the text.
    assert_matches(
        &conn,
        &[(
            "rating.isType(\"number\") && rating.abs() > 1",
            &[DUNE, EMMA],
        )],
    );
    let lists = query(&conn, &filtered("file.tags.contains('book')"), None).unwrap_err();
    assert!(
        lists.contains("`contains` is not available on a list"),
        "{lists}"
    );
}

#[test]
fn global_and_any_functions() {
    let (_dir, conn) = library();
    assert_values(
        &conn,
        &[
            ("if(owned, \"yes\", \"no\")", json!("yes")),
            ("if(missing, \"yes\", \"no\")", json!("no")),
            ("if(false, 1)", json!(null)),
            // Only the chosen branch is evaluated.
            ("if(true, 1, number(\"x\"))", json!(1)),
            ("list(status)", json!(["read"])),
            ("list(authors)", json!(["Frank", "Brian"])),
            ("list(missing)", json!([])),
            ("number(\" 3.4 \")", json!(3.4)),
            ("number(true) + number(false)", json!(1)),
            ("number(rating)", json!(5)),
            ("number(missing)", json!(null)),
            ("min(rating, 2, 9)", json!(2)),
            ("max(rating, 2, -9)", json!(5)),
            ("max(rating)", json!(5)),
            ("min(rating, missing)", json!(null)),
            ("rating.isTruthy()", json!(true)),
            ("missing.isTruthy()", json!(false)),
            ("\"\".isTruthy()", json!(false)),
            ("status.isType(\"string\")", json!(true)),
            ("rating.isType(\"number\")", json!(true)),
            ("owned.isType(\"boolean\")", json!(true)),
            ("authors.isType(\"list\")", json!(true)),
            ("file.mtime.isType(\"date\")", json!(true)),
            ("missing.isType(\"null\")", json!(true)),
            ("file.properties.isType(\"object\")", json!(true)),
            ("link(\"Emma\").isType(\"link\")", json!(true)),
            ("status.isType(\"number\")", json!(false)),
            ("rating.toString() + 1", json!("51")),
            ("2.50.toString()", json!("2.5")),
            ("(-0).toString()", json!("0")),
            ("owned.toString()", json!("true")),
            ("authors.toString()", json!("Frank, Brian")),
            ("missing.toString()", json!("")),
            ("link(\"Emma\", \"E\").toString()", json!("[[Emma|E]]")),
        ],
    );
}

#[test]
fn string_functions() {
    let (_dir, conn) = library();
    assert_values(
        &conn,
        &[
            ("\"hello\".contains(\"ell\")", json!(true)),
            ("\"hello\".contains(\"x\")", json!(false)),
            ("\"hello\".containsAll(\"h\", \"e\")", json!(true)),
            ("\"hello\".containsAll(\"h\", \"x\")", json!(false)),
            ("\"hello\".containsAny(\"x\", \"e\")", json!(true)),
            ("\"hello\".containsAny(\"x\", \"y\")", json!(false)),
            ("status.startsWith(\"re\")", json!(true)),
            ("status.endsWith(\"re\")", json!(false)),
            ("\"\".isEmpty()", json!(true)),
            ("status.isEmpty()", json!(false)),
            ("missing.isEmpty()", json!(true)),
            ("\"ÄbC\".lower()", json!("äbc")),
            ("\"hELLO  wide-world\".title()", json!("Hello  Wide-world")),
            ("\"  hi \".trim()", json!("hi")),
            ("\"a:b:c\".replace(\":\", \"-\")", json!("a-b-c")),
            ("\"hello\".slice(1, 4)", json!("ell")),
            ("\"héllo\".slice(1)", json!("éllo")),
            ("\"hello\".slice(-3, -1)", json!("ll")),
            ("\"hello\".slice(4, 2)", json!("")),
            ("\"hello\".slice(-99, 99)", json!("hello")),
            ("\"a,b,c\".split(\",\")", json!(["a", "b", "c"])),
            ("\"a,b,c\".split(\",\", 2)", json!(["a", "b"])),
            ("\"abc\".split(\"\")", json!(["a", "b", "c"])),
            ("\"123\".repeat(2)", json!("123123")),
            ("\"123\".repeat(0)", json!("")),
            ("\"\".repeat(1000000000)", json!("")),
            ("\"héllo\".reverse()", json!("olléh")),
            ("\"héllo\".length", json!(5)),
            ("file.name.lower().length", json!(7)),
            // No value in, no value out.
            ("missing.lower()", json!(null)),
            ("missing.length", json!(null)),
            ("status.contains(missing)", json!(null)),
        ],
    );
}

#[test]
fn number_functions() {
    let (_dir, conn) = library();
    assert_values(
        &conn,
        &[
            ("(-5).abs()", json!(5)),
            ("2.1.ceil()", json!(3)),
            ("2.9.floor()", json!(2)),
            ("2.5.round()", json!(3)),
            ("2.3333.round(2)", json!(2.33)),
            ("3.14159.toFixed(2)", json!("3.14")),
            ("rating.toFixed(2)", json!("5.00")),
            ("rating.isEmpty()", json!(false)),
            ("missing.round()", json!(null)),
            ("missing.toFixed(2)", json!(null)),
        ],
    );
}

#[test]
fn wrong_values_and_huge_results_are_errors_of_the_cell() {
    let (_dir, conn) = library();
    for (expression, wanted) in [
        ("rating.lower()", "`lower` is not available on a number"),
        ("status.abs()", "`abs` is not available on a string"),
        ("authors.isEmpty()", "`isEmpty` is not available on a list"),
        ("authors.length", "`length` is not available on a list"),
        (
            "status.contains(1)",
            "`contains` takes a text, found a number",
        ),
        ("status.isType(1)", "`isType` takes a text, found a number"),
        (
            "status.slice(\"1\")",
            "`slice` takes a number, found a string",
        ),
        ("status.repeat(-1)", "`repeat` takes a count of 0 or more"),
        (
            "status.split(\"a\", -1)",
            "`split` takes a limit of 0 or more",
        ),
        ("rating.toFixed(101)", "`toFixed` takes 0 to 100 digits"),
        ("rating.round(-1)", "`round` takes 0 to 100 digits"),
        ("min(status)", "`min` takes numbers, found a string"),
        ("number(\"inf\")", "`number` cannot read \"inf\""),
        ("number(authors)", "`number` is not available on a list"),
        ("link(1)", "`link` is not available on a number"),
        ("status.repeat(1000000000)", "too large"),
        (
            "\"a\".repeat(1000).replace(\"a\", \"b\".repeat(1000))",
            "too large",
        ),
        ("\"a\".repeat(60000) + \"a\".repeat(60000)", "too large"),
        ("[\"a\".repeat(60000), \"a\".repeat(60000)]", "too large"),
        ("\"a\".repeat(60000).split(\"\")", "too large"),
    ] {
        let cell = evaluated(&conn, DUNE, expression);
        assert_eq!(cell.kind.as_deref(), Some("error"), "{expression}");
        let message = cell.value.as_str().unwrap();
        assert!(message.contains(wanted), "{expression}: {message}");
    }
}

#[test]
fn long_expressions_and_chains_of_formulas_are_evaluated() {
    let (_dir, conn) = library();
    let long = format!("1{}", " + 1".repeat(240));
    assert_eq!(evaluated(&conn, DUNE, &long), cell("number", json!(241)));
    let mut formulas: String = (0..5000)
        .map(|i| format!("  f{i}: formula.f{} + formula.f{}\n", i + 1, i + 1))
        .collect();
    formulas.push_str("  f5000: '0'\n");
    let source = format!("formulas:\n{formulas}views:\n  - type: table\n    order: [formula.f0]\n");
    let result = query(&conn, &source, None).unwrap();
    assert_eq!(result.rows[0].cells[0], cell("number", json!(0)));
    // Lists inside lists stop at a depth.
    let mut formulas: String = (0..100)
        .map(|i| format!("  f{i}: '[formula.f{}]'\n", i + 1))
        .collect();
    formulas.push_str("  f100: '0'\n");
    let source = format!("formulas:\n{formulas}views:\n  - type: table\n    order: [formula.f0]\n");
    let result = query(&conn, &source, None).unwrap();
    assert_eq!(
        result.rows[0].cells[0],
        cell("error", json!("the value is too large"))
    );
}

#[test]
fn links_name_a_file_or_a_url() {
    let (_dir, conn) = library();
    let value = |expression: &str| evaluated(&conn, DUNE, expression);
    assert_eq!(
        value("link(\"[[Emma|x]]\", \"Novel\")"),
        cell(
            "link",
            json!({ "text": "Novel", "path": EMMA, "url": null })
        )
    );
    assert_eq!(
        value("link(\"Ghost\")"),
        cell(
            "link",
            json!({ "text": "Ghost", "path": null, "url": null })
        )
    );
    assert_eq!(
        value("link(\"https://example.org/a\", \"Site\")"),
        cell(
            "link",
            json!({ "text": "Site", "path": null, "url": "https://example.org/a" })
        )
    );
    assert_eq!(value("link(missing)"), BaseCell::default());
    assert_eq!(value("[link(\"Emma\")]"), cell("list", json!(["Emma"])));
    assert_values(
        &conn,
        &[
            (
                "link(\"Emma\") == link(\"books/old/Emma.md\", \"x\")",
                json!(true),
            ),
            ("link(\"Ghost\") == link(\"ghost\")", json!(true)),
            ("link(\"Ghost\") == link(\"Emma\")", json!(false)),
            ("file.hasLink(link(\"Emma\"))", json!(true)),
            (
                "link(link(\"Emma\"), \"y\").toString()",
                json!("[[Emma|y]]"),
            ),
        ],
    );
}
