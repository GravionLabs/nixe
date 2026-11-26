use std::fs;

use chrono::TimeZone;
use serde_json::json;

use super::*;
use crate::index;
use crate::test_dir::TestDir;

/// The query with the real clock, for what does not depend on the time.
fn query_now(conn: &Connection, source: &str, view: Option<&str>) -> Result<BaseResult, String> {
    let view = view.map(|name| {
        let views = views(source).unwrap();
        let named = |v: &BaseView| v.name.as_deref() == Some(name);
        views.iter().position(named).unwrap_or(views.len())
    });
    query(
        conn,
        source,
        view,
        None,
        None,
        chrono::Utc::now().timestamp_millis(),
    )
}

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

    let result = query_now(&conn, &source, None).unwrap();

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
fn the_second_view_of_the_fixture_base_groups_sorts_and_limits() {
    let dir = TestDir::new("nixe-bases-fixture-view-");
    let vault = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/vault");
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    let source = fs::read_to_string(vault.join("Notes.base")).unwrap();

    let result = query_now(&conn, &source, Some("By publication")).unwrap();

    assert!(result.unsupported.is_empty());
    assert!((1..=5).contains(&result.rows.len()));
    let groups = result.grouping.unwrap().groups;
    assert_eq!(
        groups.iter().map(|g| g.rows).sum::<usize>(),
        result.rows.len()
    );
}

#[test]
fn without_order_every_note_is_a_row_with_its_name() {
    let (_dir, conn) = indexed();
    let result = query_now(&conn, "views:\n  - type: table\n    name: All\n", None).unwrap();
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
    let result = query_now(&conn, source, None).unwrap();
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
    // Only the columns of note properties name one, without the prefix: those can be edited.
    let properties: Vec<Option<&str>> = result
        .columns
        .iter()
        .map(|c| c.property.as_deref())
        .collect();
    assert_eq!(
        properties,
        [
            Some("status"),
            None,
            Some("rating"),
            Some("owned"),
            Some("finished"),
            Some("tags"),
            Some("missing")
        ]
    );
}

#[test]
fn unsupported_parts_are_named_and_not_applied() {
    let (_dir, conn) = indexed();
    let source = r#"
summaries: { custom: 'values.mean()' }
views:
  - type: table
    summaries: { rating: Average }
    order: [file.unknown, rating]
"#;
    let result = query_now(&conn, source, None).unwrap();
    assert_eq!(
        result.unsupported,
        ["summaries", "view summaries", "column file.unknown"]
    );
    assert_eq!(ids(&result), ["rating"]);
    assert_eq!(result.rows.len(), 2);
}

#[test]
fn a_view_with_unsupported_columns_only_shows_the_name() {
    let (_dir, conn) = indexed();
    let source = "views:\n  - type: table\n    order: [file.unknown]\n";
    let result = query_now(&conn, source, None).unwrap();
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
    let result = query_now(conn, source, None).unwrap_or_else(|e| panic!("{source}: {e}"));
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
        let result = query_now(&conn, source, Some(view)).unwrap();
        result.rows.into_iter().map(|r| r.path).collect::<Vec<_>>()
    };
    assert_eq!(rows("Read"), [DUNE]);
    assert_eq!(rows("All"), [DUNE, EMMA]);
    // The filters of another view are not read.
    assert!(query_now(&conn, source, Some("Broken")).is_err());
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
    let result = query_now(&conn, source, None).unwrap();
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
            "filters: false && html(\"x\") > 1",
            "Invalid filters: unknown function `html` in `false && html(\"x\") > 1`.",
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
        let error = query_now(&conn, &base, None).unwrap_err();
        assert!(error.contains(wanted), "{source}: {error}");
    }
    let error = query_now(&conn, &filtered("nope()"), None).unwrap_err();
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
        query_now(&conn, source, None).unwrap().view.as_deref(),
        Some("A")
    );
    assert_eq!(
        query_now(&conn, source, Some("B")).unwrap().view.as_deref(),
        Some("B")
    );
    let cards = query_now(&conn, source, Some("C")).unwrap();
    assert!(cards.cards.is_some());
    let list = "views:\n  - { type: list, name: L }\n";
    let list = query_now(&conn, list, Some("L")).unwrap_err();
    assert!(list.contains("\"list\" are not supported"), "{list}");
    let missing = query_now(&conn, source, Some("D")).unwrap_err();
    assert_eq!(missing, "The base no longer has this view.");
}

#[test]
fn a_base_without_a_table_view_and_invalid_yaml_are_errors() {
    let (_dir, conn) = indexed();
    let list = query_now(&conn, "views:\n  - type: list\n", None).unwrap_err();
    assert!(list.contains("\"list\""), "{list}");
    assert_eq!(
        query_now(&conn, "", None).unwrap_err(),
        "The base defines no view."
    );
    assert!(query_now(&conn, "views: [", None)
        .unwrap_err()
        .starts_with("Invalid YAML"));
}

/// The cell of the formula `expression` for the note `path` of the library.
fn evaluated(conn: &Connection, path: &str, expression: &str) -> BaseCell {
    let source = serde_json::json!({
        "formulas": { "x": expression },
        "views": [{ "type": "table", "order": ["formula.x"] }],
    });
    let result = query_now(conn, &source.to_string(), None).unwrap();
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
    let result = query_now(&conn, source, None).unwrap();
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
        assert_eq!(query_now(&conn, &base(filter), None).unwrap_err(), wanted);
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
    let result = query_now(&conn, &columns, None).unwrap();
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
        query_now(&conn, &filtered, None).unwrap_err(),
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
    let result = query_now(&conn, source, None).unwrap();
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
        query_now(&conn, &filtered("rating.abs() > 1"), None).unwrap_err(),
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
    let numbers = query_now(&conn, &filtered("rating.contains('5')"), None).unwrap_err();
    assert!(
        numbers.contains("`contains` is not available on a number"),
        "{numbers}"
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
        ("owned.isEmpty()", "`isEmpty` is not available on a boolean"),
        ("rating.length", "`length` is not available on a number"),
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
    let result = query_now(&conn, &source, None).unwrap();
    assert_eq!(result.rows[0].cells[0], cell("number", json!(0)));
    // Lists inside lists stop at a depth.
    let mut formulas: String = (0..100)
        .map(|i| format!("  f{i}: '[formula.f{}]'\n", i + 1))
        .collect();
    formulas.push_str("  f100: '0'\n");
    let source = format!("formulas:\n{formulas}views:\n  - type: table\n    order: [formula.f0]\n");
    let result = query_now(&conn, &source, None).unwrap();
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

#[test]
fn the_formula_values_of_a_note_and_of_the_table_are_limited() {
    let (_dir, conn) = library();
    // A chain whose every formula keeps a large value.
    let mut formulas: String = (0..30)
        .map(|i| format!("  f{i}: formula.f{} + \"\"\n", i + 1))
        .collect();
    formulas.push_str("  f30: '\"x\".repeat(90000)'\n");
    let source = format!(
        "formulas:\n{formulas}  one: '1'\nviews:\n  - type: table\n    \
         order: [formula.f0, formula.f30, formula.one]\n"
    );
    let result = query_now(&conn, &source, None).unwrap();
    assert_eq!(result.rows.len(), 4);
    for row in &result.rows {
        assert_eq!(
            row.cells[0],
            cell("error", json!("the formulas of this note are too large"))
        );
        assert_eq!(row.cells[1].kind.as_deref(), Some("text"));
        // What still fits is shown.
        assert_eq!(row.cells[2], cell("number", json!(1)));
    }
    // One column repeated over and over.
    let order = vec!["formula.big"; 200].join(", ");
    let source = format!(
        "formulas:\n  big: '\"x\".repeat(90000)'\nviews:\n  - type: table\n    order: [{order}]\n"
    );
    let result = query_now(&conn, &source, None).unwrap();
    let cells: Vec<&BaseCell> = result.rows.iter().flat_map(|r| &r.cells).collect();
    let shown = cells.iter().filter(|c| c.kind.as_deref() == Some("text"));
    assert_eq!(shown.count(), 10_000_000 / 90_000);
    assert_eq!(
        **cells.last().unwrap(),
        cell(
            "error",
            json!("the formula values of the table are too large")
        )
    );
}

#[test]
fn the_message_of_an_unknown_formula_is_cut() {
    let (_dir, conn) = library();
    let source = format!(
        "views:\n  - type: table\n    order: ['formula.{}']\n",
        "x".repeat(10_000)
    );
    let result = query_now(&conn, &source, None).unwrap();
    let message = format!("unknown formula `{}…`", "x".repeat(40));
    assert_eq!(result.rows[0].cells[0], cell("error", json!(message)));
}

/// The clock of the tests: a local time, so they hold in every time zone.
fn clock() -> i64 {
    chrono::Local
        .with_ymd_and_hms(2026, 6, 15, 13, 45, 30)
        .unwrap()
        .timestamp_millis()
}

/// A vault with dates and lists in its properties.
fn calendar() -> (TestDir, Connection) {
    let dir = TestDir::new("nixe-bases-dates-");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    for (path, text) in [
        (
            "Done.md",
            "---\ndue: 2026-06-10\nstarted: 2026-06-01 08:30\nwrong: 2026-02-30\n\
             marks: [3, 1, 2, 3, 1]\nwords: [c, a, b, a]\nnested: [1, [2, [3]]]\nempty: []\n\
             days: [2026-06-10]\n---\n",
        ),
        ("Open.md", "---\ndue: 2026-06-20\n---\n"),
        ("Today.md", "---\ndue: 2026-06-15\n---\n"),
    ] {
        fs::write(vault.join(path), text).unwrap();
    }
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    (dir, conn)
}

/// The cell of the formula `expression` for `Done.md`, at the time of `clock`.
fn at_clock(conn: &Connection, expression: &str) -> BaseCell {
    let source = serde_json::json!({
        "formulas": { "x": expression },
        "views": [{ "type": "table", "order": ["formula.x"] }],
    });
    let result = query(conn, &source.to_string(), None, None, None, clock()).unwrap();
    let row = result.rows.into_iter().find(|r| r.path == "Done.md");
    row.unwrap().cells.into_iter().next().unwrap()
}

#[track_caller]
fn assert_cells(conn: &Connection, kind: &str, cases: &[(&str, serde_json::Value)]) {
    for (expression, wanted) in cases {
        assert_eq!(
            at_clock(conn, expression),
            cell(kind, wanted.clone()),
            "{expression}"
        );
    }
}

#[test]
fn date_functions_and_fields() {
    let (_dir, conn) = calendar();
    assert_cells(
        &conn,
        "date",
        &[
            ("now()", json!("2026-06-15 13:45:30")),
            ("today()", json!("2026-06-15")),
            ("now().date()", json!("2026-06-15")),
            (
                "date(\"2025-01-01 12:00:00\")",
                json!("2025-01-01 12:00:00"),
            ),
            ("date(\"2025-01-01\")", json!("2025-01-01")),
            ("date(due)", json!("2026-06-10")),
            ("due", json!("2026-06-10")),
            ("started", json!("2026-06-01 08:30:00")),
            ("started.date()", json!("2026-06-01")),
        ],
    );
    assert_cells(
        &conn,
        "number",
        &[
            ("now().year", json!(2026)),
            ("now().month", json!(6)),
            ("now().day", json!(15)),
            ("now().hour", json!(13)),
            ("now().minute", json!(45)),
            ("now().second", json!(30)),
            ("now().millisecond", json!(0)),
            ("date(\"2026-06-15 13:45:30.250\").millisecond", json!(250)),
            ("due.day", json!(10)),
        ],
    );
    assert_cells(
        &conn,
        "text",
        &[
            ("due.format(\"DD.MM.YYYY\")", json!("10.06.2026")),
            (
                "now().format(\"dddd, MMM D [at] HH:mm\")",
                json!("Monday, Jun 15 at 13:45"),
            ),
            ("now().time()", json!("13:45:30")),
            ("due.relative()", json!("6 days ago")),
            (
                "date(\"2026-06-18 13:45:30\").relative()",
                json!("in 3 days"),
            ),
            ("due.toString()", json!("2026-06-10")),
            ("\"Due \" + due", json!("Due 2026-06-10")),
            // A date that does not exist stays a text.
            ("wrong", json!("2026-02-30")),
        ],
    );
    assert_cells(
        &conn,
        "checkbox",
        &[
            ("due.isEmpty()", json!(false)),
            ("due.isType(\"date\")", json!(true)),
            ("wrong.isType(\"string\")", json!(true)),
            ("missing.isEmpty()", json!(true)),
            ("due.isTruthy()", json!(true)),
        ],
    );
    for expression in [
        "date(missing)",
        "missing.year",
        "missing.format(\"YYYY\")",
        "due.format(missing)",
        "missing.relative()",
        "duration(missing)",
    ] {
        assert_eq!(
            at_clock(&conn, expression),
            BaseCell::default(),
            "{expression}"
        );
    }
}

#[test]
fn date_arithmetic() {
    let (_dir, conn) = calendar();
    assert_cells(
        &conn,
        "date",
        &[
            (
                "date(\"2024-12-01\") + \"1M\" + \"4h\" + \"3m\"",
                json!("2025-01-01 04:03:00"),
            ),
            ("now() + \"1 day\"", json!("2026-06-16 13:45:30")),
            ("now() - \"2h\"", json!("2026-06-15 11:45:30")),
            ("today() + \"1 week\"", json!("2026-06-22")),
            ("due - \"1y\"", json!("2025-06-10")),
            ("due + \"1 month\"", json!("2026-07-10")),
            ("now() + duration(\"1d\") * 2", json!("2026-06-17 13:45:30")),
            ("due + (today() - due)", json!("2026-06-15")),
        ],
    );
    assert_cells(
        &conn,
        "text",
        &[
            ("today() - due", json!("5 days")),
            ("now() - today()", json!("13 hours 45 minutes 30 seconds")),
            ("duration(\"5h\") * 2", json!("10 hours")),
            ("duration(\"1d\") / 2", json!("12 hours")),
            ("duration(\"1d\") + \"2h\"", json!("1 day 2 hours")),
            ("duration(\"1w\") - duration(\"1d\")", json!("6 days")),
            ("duration(\"1y\").toString()", json!("1 year")),
        ],
    );
    assert_cells(
        &conn,
        "number",
        &[
            ("number(today() - due) / 86400000", json!(5)),
            ("number(duration(\"2s\"))", json!(2000)),
        ],
    );
    for expression in [
        "due + \"soon\"",
        "due + 1",
        "due * 2",
        "\"1d\" - due",
        "duration(\"1d\") / 0",
        "2 * duration(\"1d\")",
        "due + \"999999999y\"",
        "missing + \"1d\"",
    ] {
        assert_eq!(
            at_clock(&conn, expression),
            BaseCell::default(),
            "{expression}"
        );
    }
}

#[test]
fn dates_compare_in_filters() {
    let (_dir, conn) = calendar();
    let matching = |filter: &str| -> Vec<String> {
        let result = query(&conn, &filtered(filter), None, None, None, clock()).unwrap();
        result.rows.into_iter().map(|r| r.path).collect()
    };
    let cases: [(&str, &[&str]); 11] = [
        ("due < today()", &["Done.md"]),
        ("due <= today()", &["Done.md", "Today.md"]),
        ("due == today()", &["Today.md"]),
        ("due != today()", &["Done.md", "Open.md"]),
        ("due > now()", &["Open.md"]),
        ("due >= date(\"2026-06-15\")", &["Open.md", "Today.md"]),
        (
            "due > now() - \"1 week\"",
            &["Done.md", "Open.md", "Today.md"],
        ),
        ("due == \"2026-06-20\"", &["Open.md"]),
        ("today() - due > \"4d\"", &["Done.md"]),
        (
            "duration(\"1w\") == duration(\"7d\") && due.day == 20",
            &["Open.md"],
        ),
        (
            "file.mtime > date(\"2000-01-01\")",
            &["Done.md", "Open.md", "Today.md"],
        ),
    ];
    for (filter, wanted) in cases {
        assert_eq!(matching(filter), wanted, "{filter}");
    }
}

#[test]
fn list_functions() {
    let (_dir, conn) = calendar();
    assert_cells(
        &conn,
        "checkbox",
        &[
            ("[1,2,3].contains(2)", json!(true)),
            ("marks.contains(9)", json!(false)),
            ("marks.contains(\"3\")", json!(false)),
            ("[1,2,3].containsAll(2,3)", json!(true)),
            ("[1,2,3].containsAll(2,4)", json!(false)),
            ("[1,2,3].containsAny(3,4)", json!(true)),
            ("[1,2,3].containsAny(4,5)", json!(false)),
            ("days.contains(date(\"2026-06-10\"))", json!(true)),
            ("[1,2,3].isEmpty()", json!(false)),
            ("empty.isEmpty()", json!(true)),
        ],
    );
    assert_cells(
        &conn,
        "list",
        &[
            ("[1,[2,3]].flat()", json!([1, 2, 3])),
            // One level.
            ("nested.flat()", json!([1, 2, [3]])),
            ("[1,2,2,3].unique()", json!([1, 2, 3])),
            ("words.unique()", json!(["c", "a", "b"])),
            ("[1, \"1\", 1].unique()", json!([1, "1"])),
            (
                "[link(\"Open\"), link(\"Open.md\")].unique()",
                json!(["Open"]),
            ),
            ("marks.sort()", json!([1, 1, 2, 3, 3])),
            ("[\"c\", \"a\", \"b\"].sort()", json!(["a", "b", "c"])),
            ("[10, 9, -1].sort()", json!([-1, 9, 10])),
            ("[today(), due].sort()", json!(["2026-06-10", "2026-06-15"])),
            (
                "[missing, \"a\", 2, true].sort()",
                json!([true, 2, "a", null]),
            ),
            ("[1,2,3].reverse()", json!([3, 2, 1])),
            ("[1,2,3,4].slice(1,3)", json!([2, 3])),
            ("[1,2,3,4].slice(2)", json!([3, 4])),
            ("[1,2,3,4].slice(-2)", json!([3, 4])),
            ("[1,2,3,4].slice(3,1)", json!([])),
            ("[1,2,3,4].slice(-9,9)", json!([1, 2, 3, 4])),
            ("empty.sort().reverse().unique().flat()", json!([])),
        ],
    );
    assert_cells(
        &conn,
        "text",
        &[
            ("[1,2,3].join(\",\")", json!("1,2,3")),
            ("words.join(\" / \")", json!("c / a / b / a")),
            ("empty.join(\",\")", json!("")),
        ],
    );
    assert_cells(
        &conn,
        "number",
        &[("marks.length", json!(5)), ("empty.length", json!(0))],
    );
    // The property itself is not changed.
    assert_cells(
        &conn,
        "text",
        &[(
            "marks.sort().join(\"\") + \" \" + marks.join(\"\")",
            json!("11233 31231"),
        )],
    );
    for expression in [
        "missing.join(\",\")",
        "missing.sort()",
        "marks.contains(missing)",
        "marks.join(missing)",
        "marks.slice(missing)",
    ] {
        assert_eq!(
            at_clock(&conn, expression),
            BaseCell::default(),
            "{expression}"
        );
    }
}

#[test]
fn wrong_dates_and_lists_are_errors_of_the_cell() {
    let (_dir, conn) = calendar();
    for (expression, wanted) in [
        ("date(\"tomorrow\")", "`date` cannot read \"tomorrow\""),
        ("date(1)", "`date` is not available on a number"),
        ("duration(\"1 eon\")", "`duration` cannot read \"1 eon\""),
        ("duration(1)", "`duration` is not available on a number"),
        ("marks.year", "`year` is not available on a list"),
        ("marks.format(\"Y\")", "`format` is not available on a list"),
        ("due.format(1)", "`format` takes a text, found a number"),
        (
            "due.contains(\"6\")",
            "`contains` is not available on a date",
        ),
        ("due.sort()", "`sort` is not available on a date"),
        ("wrong.flat()", "`flat` is not available on a string"),
        ("marks.lower()", "`lower` is not available on a list"),
        ("marks.join(1)", "`join` takes a text, found a number"),
        (
            "marks.slice(\"1\")",
            "`slice` takes a number, found a string",
        ),
        ("marks.join(\"x\".repeat(90000))", "too large"),
        ("due.format(\"[\".repeat(100000))", "the format is too long"),
        (
            "duration(\"1\" + \"0\".repeat(300) + \"h\")",
            "`duration` cannot read",
        ),
        (
            "\"x\".repeat(6000).split(\"\").join(\",\").split(\",\").flat().join(\"y\".repeat(20))",
            "too large",
        ),
    ] {
        let cell = at_clock(&conn, expression);
        assert_eq!(cell.kind.as_deref(), Some("error"), "{expression}");
        let message = cell.value.as_str().unwrap();
        assert!(message.contains(wanted), "{expression}: {message}");
    }
}

#[test]
fn dates_and_durations_are_as_large_as_their_texts() {
    let date = eval::Value::Date(date::Date::parse("2026-06-10").unwrap());
    assert_eq!(functions::size(&date), Ok(19));
    let duration = eval::Value::Duration(date::Duration::parse("14M").unwrap());
    assert_eq!(functions::size(&duration), Ok("1 year 2 months".len()));
}

#[test]
fn a_date_names_its_daily_note() {
    let dir = TestDir::new("nixe-bases-daily-");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("2026-06-10.md"), "").unwrap();
    fs::write(
        vault.join("Done.md"),
        "---\ndue: 2026-06-10\n---\n[[2026-06-10]]\n",
    )
    .unwrap();
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    assert_eq!(
        at_clock(&conn, "file.hasLink(due)"),
        cell("checkbox", json!(true))
    );
    assert_eq!(
        at_clock(&conn, "link(due)"),
        cell(
            "link",
            json!({ "text": "2026-06-10", "path": "2026-06-10.md", "url": null })
        )
    );
}

/// The paths of the rows of the first table view.
fn shown(conn: &Connection, view: &str) -> Vec<String> {
    let source = format!("views:\n  - type: table\n{view}");
    let result = query_now(conn, &source, None).unwrap();
    assert!(result.unsupported.is_empty(), "{:?}", result.unsupported);
    result.rows.into_iter().map(|r| r.path).collect()
}

/// Notes with a `kind`, a `rank` and a `due` date; `none.md` has none of them.
fn ranked() -> (TestDir, Connection) {
    let dir = TestDir::new("nixe-bases-arrange-");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    for (name, frontmatter) in [
        ("a", "kind: tool\nrank: 10\ndue: 2026-03-01\ntitle: beta"),
        ("b", "kind: Book\nrank: 2\ndue: 2026-01-01\ntitle: Alpha"),
        ("c", "kind: tool\nrank: 2\ntitle: gamma"),
        ("d", "kind: game\nrank: 7\ndue: 2026-02-01"),
    ] {
        fs::write(
            vault.join(format!("{name}.md")),
            format!("---\n{frontmatter}\n---\n"),
        )
        .unwrap();
    }
    fs::write(vault.join("none.md"), "text\n").unwrap();
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    (dir, conn)
}

/// Each group as the text of its value with the paths of its rows.
fn grouped(result: &BaseResult) -> Vec<(serde_json::Value, Vec<&str>)> {
    let mut rows = result.rows.iter().map(|r| r.path.as_str());
    let grouping = result.grouping.as_ref().unwrap();
    let groups = grouping
        .groups
        .iter()
        .map(|g| (g.value.value.clone(), rows.by_ref().take(g.rows).collect()))
        .collect();
    assert_eq!(rows.next(), None);
    groups
}

#[test]
fn the_saved_sort_orders_the_rows_with_missing_values_last() {
    let (_dir, conn) = ranked();
    assert_eq!(
        shown(
            &conn,
            "    sort:\n      - { property: note.rank, direction: ASC }\n"
        ),
        ["b.md", "c.md", "d.md", "a.md", "none.md"]
    );
    assert_eq!(
        shown(
            &conn,
            "    sort:\n      - { property: rank, direction: DESC }\n"
        ),
        ["a.md", "d.md", "b.md", "c.md", "none.md"]
    );
    // The key of earlier versions of Obsidian.
    assert_eq!(
        shown(
            &conn,
            "    sort:\n      - { column: note.rank, direction: DESC }\n"
        ),
        ["a.md", "d.md", "b.md", "c.md", "none.md"]
    );
    // The first key counts most; the property needs no column; texts ignore case.
    assert_eq!(
        shown(
            &conn,
            "    sort:\n      - { property: rank }\n      - { property: file.name, direction: desc }\n"
        ),
        ["c.md", "b.md", "d.md", "a.md", "none.md"]
    );
    assert_eq!(
        shown(&conn, "    sort: [{ property: title, direction: ASC }]\n"),
        ["b.md", "a.md", "c.md", "d.md", "none.md"]
    );
    assert_eq!(
        shown(&conn, "    sort: [{ property: due, direction: DESC }]\n"),
        ["a.md", "d.md", "b.md", "c.md", "none.md"]
    );
    assert_eq!(
        shown(&conn, "    sort: []\n    groupBy: {}\n"),
        ["a.md", "b.md", "c.md", "d.md", "none.md"]
    );
}

#[test]
fn limit_keeps_the_first_rows_of_the_sort() {
    let (_dir, conn) = ranked();
    assert_eq!(shown(&conn, "    limit: 2\n"), ["a.md", "b.md"]);
    assert_eq!(
        shown(
            &conn,
            "    limit: 2\n    sort: [{ property: rank, direction: DESC }]\n"
        ),
        ["a.md", "d.md"]
    );
    assert_eq!(shown(&conn, "    limit: 50\n").len(), 5);
}

#[test]
fn only_the_shown_rows_use_the_room_of_the_formula_cells() {
    let (_dir, conn) = ranked();
    let source = "formulas:\n  big: '\"x\".repeat(90000)'\n  one: '1'\nviews:\n  - type: table\n    limit: 1\n    order: [formula.big]\n    sort: [{ property: formula.one }]\n";
    let result = query_now(&conn, source, None).unwrap();
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].cells[0].kind.as_deref(), Some("text"));
}

#[test]
fn group_by_puts_the_rows_into_groups_in_its_direction() {
    let (_dir, conn) = ranked();
    let source = |direction: &str| {
        format!("properties:\n  note.kind: {{ displayName: Type }}\nviews:\n  - type: table\n    groupBy: {{ property: note.kind, direction: {direction} }}\n    sort: [{{ property: rank, direction: ASC }}]\n")
    };
    let result = query_now(&conn, &source("ASC"), None).unwrap();
    assert_eq!(result.grouping.as_ref().unwrap().label, "Type");
    assert_eq!(
        grouped(&result),
        [
            (json!("Book"), vec!["b.md"]),
            (json!("game"), vec!["d.md"]),
            (json!("tool"), vec!["c.md", "a.md"]),
            (json!(null), vec!["none.md"]),
        ]
    );
    let result = query_now(&conn, &source("DESC"), None).unwrap();
    assert_eq!(
        grouped(&result),
        [
            (json!("tool"), vec!["c.md", "a.md"]),
            (json!("game"), vec!["d.md"]),
            (json!("Book"), vec!["b.md"]),
            (json!(null), vec!["none.md"]),
        ]
    );
    assert!(query_now(&conn, "views: [{ type: table }]", None)
        .unwrap()
        .grouping
        .is_none());
}

#[test]
fn group_order_chooses_and_orders_the_groups_before_the_limit() {
    let (_dir, conn) = ranked();
    let source = |rest: &str| {
        format!(
            "views:\n  - type: table\n    groupBy: {{ property: kind, direction: ASC }}\n{rest}"
        )
    };
    // Only listed groups, in that order, also an empty one; `null` is the rows without a value.
    let result = query_now(
        &conn,
        &source("    groupOrder: [tool, film, null, Book, tool]\n"),
        None,
    )
    .unwrap();
    assert_eq!(
        grouped(&result),
        [
            (json!("tool"), vec!["a.md", "c.md"]),
            (json!("film"), vec![]),
            (json!(null), vec!["none.md"]),
            (json!("Book"), vec!["b.md"]),
        ]
    );
    // Hidden rows do not count for the limit.
    let result = query_now(
        &conn,
        &source("    groupOrder: [game, Book]\n    limit: 1\n    sort: [{ property: rank, direction: DESC }]\n"),
        None,
    )
    .unwrap();
    assert_eq!(
        grouped(&result),
        [(json!("game"), vec!["d.md"]), (json!("Book"), vec![])]
    );
    // Without `groupOrder` a group the limit leaves empty does not show.
    let result = query_now(&conn, &source("    limit: 1\n"), None).unwrap();
    assert_eq!(grouped(&result), [(json!("tool"), vec!["a.md"])]);
    let result = query_now(&conn, &source("    groupOrder: []\n"), None).unwrap();
    assert!(result.rows.is_empty() && grouped(&result).is_empty());
    // Without `groupBy` there is nothing to order.
    assert_eq!(shown(&conn, "    groupOrder: []\n").len(), 5);
}

#[test]
fn group_order_names_numbers_lists_and_formula_values() {
    let dir = TestDir::new("nixe-bases-groups-");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("a.md"), "---\nn: 3\norg: [\"[[Uni]]\"]\n---\n").unwrap();
    fs::write(vault.join("b.md"), "---\nn: 4\norg: []\n---\n").unwrap();
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    for (by, order) in [
        ("n", "[4, \"3\"]"),
        ("org", "[null, [\"[[Uni]]\"]]"),
        ("formula.big", "[true, false]"),
    ] {
        let source = format!("formulas:\n  big: n > 3\nviews:\n  - type: table\n    groupBy: {{ property: '{by}' }}\n    groupOrder: {order}\n");
        let result = query_now(&conn, &source, None).unwrap();
        let paths: Vec<&str> = result.rows.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["b.md", "a.md"], "{by}");
    }
}

#[test]
fn a_clicked_sort_comes_before_the_sort_of_the_view() {
    let (_dir, conn) = ranked();
    let source = "formulas:\n  low: kind.lower()\n  bad: rank.lower()\nviews:\n  - type: table\n    sort: [{ property: file.name, direction: DESC }]\n";
    let clicked = |property: &str, direction: &str| -> Vec<String> {
        let key: SortKey =
            serde_json::from_value(json!({ "property": property, "direction": direction }))
                .unwrap();
        let result = query(&conn, source, None, Some(&key), None, 0).unwrap();
        result.rows.into_iter().map(|r| r.path).collect()
    };
    assert_eq!(
        clicked("formula.low", "ASC"),
        ["b.md", "d.md", "c.md", "a.md", "none.md"]
    );
    // A formula that fails sorts like a missing value, and the view's sort decides.
    assert_eq!(
        clicked("formula.bad", "DESC"),
        ["none.md", "d.md", "c.md", "b.md", "a.md"]
    );
}

#[test]
fn a_formula_that_fails_in_the_sort_or_group_of_the_view_is_an_error() {
    let (_dir, conn) = ranked();
    let query = |view: &str| {
        let source = format!("formulas:\n  bad: rank.lower()\n  loop: formula.loop\nviews:\n  - type: table\n    {view}\n");
        query_now(&conn, &source, None).unwrap_err()
    };
    for (view, wanted) in [
        ("sort: [{ property: formula.bad }]", "Error in sort: "),
        ("groupBy: { property: formula.bad }", "Error in groupBy: "),
        ("sort: [{ property: formula.loop }]", "Invalid sort: "),
        ("groupBy: { property: formula.nope }", "Invalid groupBy: "),
    ] {
        let error = query(view);
        assert!(error.starts_with(wanted), "{view}: {error}");
    }
}

#[test]
fn wrong_view_settings_are_errors_and_unsupported_properties_are_named() {
    let (_dir, conn) = ranked();
    for (view, wanted) in [
        ("limit: 0", "`limit`"),
        ("limit: ten", "`limit`"),
        ("limit: -1", "`limit`"),
        ("sort: rank", "`sort` of the view must be a list"),
        ("sort: [rank]", "`sort` of the view needs a `property`"),
        (
            "sort: [{ property: rank, direction: up }]",
            "`ASC` or `DESC`",
        ),
        ("groupBy: kind", "`groupBy` of the view needs a `property`"),
        (
            "groupBy: { property: kind }\n    groupOrder: tool",
            "`groupOrder` of the view must be a list",
        ),
    ] {
        let source = format!("views:\n  - type: table\n    {view}\n");
        let error = query_now(&conn, &source, None).unwrap_err();
        assert!(error.contains(wanted), "{view}: {error}");
    }
    // Another view with wrong settings does not matter.
    let source = "views:\n  - type: table\n  - { type: table, limit: x }\n";
    assert!(query_now(&conn, source, None).is_ok());

    let source = "views:\n  - type: table\n    sort: [{ property: file.nope }]\n    groupBy: { property: file.other }\n";
    let result = query_now(&conn, source, None).unwrap();
    assert_eq!(result.unsupported, ["sort file.nope", "groupBy file.other"]);
    assert!(result.grouping.is_none());
    assert_eq!(result.rows.len(), 5);
}

#[test]
fn the_views_of_a_base_are_listed_in_their_order() {
    let list = views("views:\n  - { type: cards, name: C }\n  - { type: table }\n").unwrap();
    let list: Vec<(Option<&str>, &str)> = list
        .iter()
        .map(|v| (v.name.as_deref(), v.kind.as_str()))
        .collect();
    assert_eq!(list, [(Some("C"), "cards"), (None, "table")]);
    assert!(views("views: x").is_err());
}

#[test]
fn a_clicked_sort_takes_no_room_from_the_keys_of_the_view() {
    let dir = TestDir::new("nixe-bases-room-");
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).unwrap();
    // Together a bit more than half of the room for the keys.
    for i in 0..70 {
        fs::write(vault.join(format!("{i:02}.md")), "text\n").unwrap();
    }
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    let source = "formulas:\n  big: '\"x\".repeat(90000)'\nviews:\n  - type: table\n    sort: [{ property: formula.big }]\n";
    let clicked: SortKey = serde_json::from_value(json!({ "property": "formula.big" })).unwrap();

    let result = query(&conn, source, None, Some(&clicked), None, 0).unwrap();

    assert_eq!(result.rows.len(), 70);
    // More than the room: the view's sort is an error, the clicked one is not.
    for i in 70..120 {
        fs::write(vault.join(format!("{i}.md")), "text\n").unwrap();
    }
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    let error = query(&conn, source, None, None, None, 0).unwrap_err();
    assert_eq!(error, "The values to sort and group by are too large.");
    let unsorted = source.replace("    sort: [{ property: formula.big }]\n", "");
    let result = query(&conn, &unsorted, None, Some(&clicked), None, 0).unwrap();
    assert_eq!(result.rows.len(), 120);
}

/// A scanned vault whose notes name their cover in the property `cover`.
fn covers(notes: &[(&str, &str)]) -> (TestDir, Connection) {
    let dir = TestDir::new("nixe-bases-cards-");
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("notes/img")).unwrap();
    fs::create_dir_all(vault.join("art")).unwrap();
    for image in ["notes/img/near.png", "art/Far Away.JPG", "root.svg"] {
        fs::write(vault.join(image), "image").unwrap();
    }
    for (name, cover) in notes {
        let text = format!("---\ncover: {cover}\n---\n");
        fs::write(vault.join(format!("notes/{name}.md")), text).unwrap();
    }
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    (dir, conn)
}

#[test]
fn covers_are_vault_images_web_addresses_or_colors() {
    let path = |p: &str| Some(BaseCover::Path(p.into()));
    let url = |u: &str| Some(BaseCover::Url(u.into()));
    let cases = [
        // Seen from the note, as in a Markdown image.
        ("a", "img/near.png", path("notes/img/near.png")),
        ("b", "../root.svg", path("root.svg")),
        ("c", "/root.svg", path("root.svg")),
        // From the vault root, by name, percent-encoded.
        ("d", "art/Far Away.JPG", path("art/Far Away.JPG")),
        ("e", "far away.jpg", path("art/Far Away.JPG")),
        ("f", "art/Far%20Away.JPG", path("art/Far Away.JPG")),
        ("w", "img/near.png?v=2", path("notes/img/near.png")),
        ("x", "\"/root.svg#top\"", path("root.svg")),
        // Wikilinks and embeds, also with a size.
        ("g", "\"[[near.png]]\"", path("notes/img/near.png")),
        ("h", "\"![[Far Away.JPG|300]]\"", path("art/Far Away.JPG")),
        ("i", "\"[[img/near.png]]\"", path("notes/img/near.png")),
        (
            "j",
            "https://example.com/a.png",
            url("https://example.com/a.png"),
        ),
        ("k", "HTTP://example.com/b", url("HTTP://example.com/b")),
        ("l", "\"#ff8800\"", Some(BaseCover::Color("#ff8800".into()))),
        // Nothing to show.
        ("m", "\"[[missing.png]]\"", None),
        ("n", "gone.png", None),
        ("o", "\"../../root.svg\"", None),
        ("p", "\"[[a]]\"", None),
        ("q", "\"javascript:alert(1)\"", None),
        ("r", "\"data:image/png;base64,AA==\"", None),
        ("s", "\"#not-a-color\"", None),
        ("t", "\"\"", None),
        ("u", "42", None),
        ("v", "[img/near.png]", None),
    ];
    let mut cases = cases;
    // The rows come sorted by path.
    cases.sort_by_key(|case| case.0);
    let notes: Vec<(&str, &str)> = cases.iter().map(|(n, c, _)| (*n, *c)).collect();
    let (_dir, conn) = covers(&notes);

    let source = "views:\n  - type: cards\n    image: note.cover\n";
    let result = query_now(&conn, source, None).unwrap();

    assert_eq!(result.rows.len(), cases.len());
    for (row, (name, cover, wanted)) in result.rows.iter().zip(cases) {
        assert_eq!(row.path, format!("notes/{name}.md"));
        assert_eq!(row.cover, wanted, "{cover}");
    }
}

#[test]
fn a_cover_can_come_from_a_formula_with_a_link() {
    let (_dir, conn) = covers(&[("a", "root")]);
    let base = |formula: &str| {
        format!("formulas:\n  c: '{formula}'\nviews:\n  - type: cards\n    image: formula.c\n")
    };
    let cover = |formula: &str| {
        let result = query_now(&conn, &base(formula), None).unwrap();
        result.rows[0].cover.clone()
    };
    let root = Some(BaseCover::Path("root.svg".into()));
    assert_eq!(cover("cover + \".svg\""), root);
    assert_eq!(cover("link(\"root.svg\")"), root);
    assert_eq!(
        cover("link(\"https://example.com/c.png\")"),
        Some(BaseCover::Url("https://example.com/c.png".into()))
    );
    assert_eq!(cover("link(\"mailto:a@example.com\")"), None);
    assert_eq!(cover("link(\"a\")"), None);
    // A formula that fails leaves the card without a cover.
    assert_eq!(cover("cover.abs()"), None);
}

#[test]
fn a_cards_view_gives_its_settings() {
    let (_dir, conn) = covers(&[("a", "img/near.png")]);
    let settings = |keys: &str| {
        let source = format!("views:\n  - type: cards\n{keys}");
        query_now(&conn, &source, None)
    };
    let defaults = settings("").unwrap();
    assert_eq!(
        serde_json::to_value(&defaults.cards).unwrap(),
        json!({ "image": false, "imageFit": "cover", "imageAspectRatio": 1.0, "cardSize": 200.0 })
    );
    assert_eq!(defaults.rows[0].cover, None);
    assert_eq!(ids(&defaults), ["file.name"]);

    let all = settings(
        "    image: cover\n    imageFit: contain\n    imageAspectRatio: 0.45\n    cardSize: 230\n    order: [file.name, cover]\n",
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&all.cards).unwrap(),
        json!({ "image": true, "imageFit": "contain", "imageAspectRatio": 0.45, "cardSize": 230.0 })
    );
    assert_eq!(ids(&all), ["file.name", "cover"]);
    assert_eq!(
        serde_json::to_value(&all.rows[0].cover).unwrap(),
        json!({ "type": "path", "value": "notes/img/near.png" })
    );

    // Obsidian writes an empty `imageFit` for its default; sizes are kept in a range.
    let wide =
        settings("    image: ''\n    imageFit: ''\n    imageAspectRatio: 100\n    cardSize: 1\n")
            .unwrap()
            .cards
            .unwrap();
    assert!(!wide.image);
    assert_eq!((wide.image_aspect_ratio, wide.card_size), (10.0, 50.0));
}

#[test]
fn wrong_card_settings_are_errors_and_an_unknown_image_property_is_named() {
    let (_dir, conn) = covers(&[("a", "img/near.png")]);
    let query = |key: &str| {
        let source = format!("views:\n  - type: cards\n    {key}\n");
        query_now(&conn, &source, None)
    };
    for (key, wanted) in [
        ("image: [cover]", "`image` of the view must be"),
        ("imageFit: fill", "`imageFit` of the view must be"),
        ("imageFit: 1", "`imageFit` of the view must be"),
        (
            "imageAspectRatio: tall",
            "`imageAspectRatio` of the view must be",
        ),
        (
            "imageAspectRatio: 0",
            "`imageAspectRatio` of the view must be",
        ),
        ("cardSize: -5", "`cardSize` of the view must be"),
    ] {
        let error = query(key).unwrap_err();
        assert!(error.contains(wanted), "{key}: {error}");
    }
    let unknown = query("image: file.file").unwrap();
    assert_eq!(unknown.unsupported, ["image file.file"]);
    assert!(!unknown.cards.unwrap().image);
}

#[test]
fn a_table_ignores_the_card_keys_and_a_cards_view_is_filtered_and_grouped() {
    let (_dir, conn) = covers(&[("a", "img/near.png"), ("b", "gone.png")]);
    let source = r#"
views:
  - type: table
    image: note.cover
    imageFit: nonsense
  - type: cards
    image: note.cover
    filters: file.name == "b.md"
    groupBy: { property: note.cover }
"#;
    let table = query_now(&conn, source, None).unwrap();
    assert!(table.cards.is_none());
    assert!(table.rows.iter().all(|r| r.cover.is_none()));

    let cards = query(&conn, source, Some(1), None, None, 0).unwrap();
    assert_eq!(cards.rows.len(), 1);
    assert_eq!(cards.rows[0].path, "notes/b.md");
    assert_eq!(cards.grouping.unwrap().groups[0].rows, 1);
}

#[test]
fn the_cards_view_of_the_fixture_base_shows_an_image_of_the_vault() {
    let dir = TestDir::new("nixe-bases-fixture-cards-");
    let vault = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/vault");
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    let source = fs::read_to_string(vault.join("Notes.base")).unwrap();

    let result = query_now(&conn, &source, Some("Gallery")).unwrap();

    assert!(result.unsupported.is_empty());
    assert_eq!(result.cards.unwrap().card_size, 220.0);
    assert_eq!(
        result.rows[0].cover,
        Some(BaseCover::Path("assets/image.svg".into()))
    );
}

/// A vault with a note and a base that both are linked to, for `this`.
fn this_vault() -> (TestDir, Connection) {
    let dir = TestDir::new("nixe-bases-this-");
    let vault = dir.join("vault");
    fs::create_dir_all(vault.join("people")).unwrap();
    fs::write(
        vault.join("people/Ann.md"),
        "---\nrole: author\nmin: 4\ntags: [person]\n---\n![[Shelf.base]]\n",
    )
    .unwrap();
    fs::write(
        vault.join("Dune.md"),
        "---\nauthor: \"[[Ann]]\"\neditors: [\"[[Ann|A.]]\", Bo]\nrating: 5\n---\nBy [[Ann]].\n",
    )
    .unwrap();
    fs::write(
        vault.join("Emma.md"),
        "---\nauthor: Ann\nrating: 3\n---\nNo link.\n",
    )
    .unwrap();
    fs::write(vault.join("Shelf.base"), "views:\n  - type: table\n").unwrap();
    let mut conn = index::open(&dir.join("index.sqlite")).unwrap();
    index::scan(&mut conn, &vault, |_| {}).unwrap();
    (dir, conn)
}

/// The notes `filter` keeps when `this` is the file at `this`.
fn kept_for(conn: &Connection, this: Option<&str>, filter: &str) -> Vec<String> {
    let source = format!(
        "views:\n  - type: table\n    filters: '{}'\n",
        filter.replace('\'', "''")
    );
    query(conn, &source, None, None, this, 0)
        .unwrap()
        .rows
        .into_iter()
        .map(|row| row.path)
        .collect()
}

#[test]
fn this_is_the_embedding_note() {
    let (_dir, conn) = this_vault();
    let ann = Some("people/Ann.md");
    for (filter, wanted) in [
        ("file.hasLink(this.file)", vec!["Dune.md"]),
        ("file.hasLink(this)", vec!["Dune.md"]),
        ("author == this", vec!["Dune.md"]),
        (
            "this != author",
            vec!["Emma.md", "Shelf.base", "people/Ann.md"],
        ),
        ("editors.contains(this)", vec!["Dune.md"]),
        ("editors.containsAny(this.file)", vec!["Dune.md"]),
        ("file.name == this.file.name", vec!["people/Ann.md"]),
        ("file.folder == this.file.folder", vec!["people/Ann.md"]),
        ("rating >= this.min", vec!["Dune.md"]),
        (
            "rating >= this[\"min\"] && this.note.role == \"author\"",
            vec!["Dune.md"],
        ),
        (
            "this.file.hasTag(\"person\") && file.name == \"Emma.md\"",
            vec!["Emma.md"],
        ),
        ("this.file.hasLink(file.name)", vec![]),
    ] {
        let mut kept = kept_for(&conn, ann, filter);
        // The base file is no note, so it is never a row.
        let wanted: Vec<&str> = wanted.into_iter().filter(|p| p.ends_with(".md")).collect();
        kept.sort();
        let mut wanted: Vec<String> = wanted.into_iter().map(String::from).collect();
        wanted.sort();
        assert_eq!(kept, wanted, "{filter}");
    }
}

#[test]
fn this_of_a_base_opened_directly_is_the_base_file() {
    let (_dir, conn) = this_vault();
    let source = r#"
formulas:
  me: this
  where: this.file.path + " " + this.file.basename + " " + this.file.ext
  back: this.file.backlinks
  none: this.role
views:
  - type: table
    filters: file.name == "Dune.md"
    order: [formula.me, formula.where, formula.back, formula.none]
"#;
    let result = query(&conn, source, None, None, Some("Shelf.base"), 0).unwrap();
    let cells = &result.rows[0].cells;
    assert_eq!(
        cells[0],
        cell(
            "link",
            json!({"text": "Shelf", "path": "Shelf.base", "url": null})
        )
    );
    assert_eq!(cells[1], cell("text", json!("Shelf.base Shelf base")));
    assert_eq!(cells[2], cell("list", json!(["people/Ann.md"])));
    assert_eq!(cells[3], BaseCell::default());
}

#[test]
fn this_without_a_file_has_no_value_and_a_file_not_indexed_yet_has_its_path() {
    let (_dir, conn) = this_vault();
    assert!(kept_for(&conn, None, "file.hasLink(this.file)").is_empty());
    assert!(kept_for(&conn, None, "this.file.name || this.min").is_empty());
    assert_eq!(
        kept_for(
            &conn,
            Some("new/Draft.md"),
            "file.name == \"Dune.md\" && this.file.folder == \"new\" && !this.min"
        ),
        ["Dune.md"]
    );
}
