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

    assert_eq!(result.unsupported, ["filters"]);
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
    assert_eq!(result.rows.len(), index::read::note_count(&conn).unwrap());
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
filters: file.hasTag("book")
formulas: { double: rating * 2 }
views:
  - type: table
    limit: 1
    filters: 'rating > 3'
    order: [formula.double, file.ext, rating]
"#;
    let result = query(&conn, source, None).unwrap();
    assert_eq!(
        result.unsupported,
        [
            "filters",
            "formulas",
            "view filters",
            "limit",
            "column formula.double",
            "column file.ext"
        ]
    );
    assert_eq!(ids(&result), ["rating"]);
    assert_eq!(result.rows.len(), 2);
}

#[test]
fn a_view_with_unsupported_columns_only_shows_the_name() {
    let (_dir, conn) = indexed();
    let source = "views:\n  - type: table\n    order: [file.mtime]\n";
    let result = query(&conn, source, None).unwrap();
    assert_eq!(ids(&result), ["file.name"]);
    assert_eq!(result.unsupported, ["column file.mtime"]);
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
