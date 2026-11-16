//! The `nixe` subcommands against `fixtures/vault/`. The index goes to a temp directory;
//! the vault is only read.

use std::path::{Path, PathBuf};

use nixe_lib::cli::{execute, CliError};
use serde_json::{json, Value};

fn vault() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/vault")
}

fn data_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nixe-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run(name: &str, args: &[&str]) -> Result<String, CliError> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let mut out = Vec::new();
    execute(&args, &vault(), &data_dir(name), &mut out)?;
    Ok(String::from_utf8(out).unwrap())
}

fn json_of(name: &str, args: &[&str]) -> Value {
    let mut args = args.to_vec();
    args.push("--json");
    serde_json::from_str(&run(name, &args).unwrap()).unwrap()
}

#[test]
fn the_vault_is_the_one_containing_the_current_directory() {
    // `cwd` is the vault itself here, with no --vault argument.
    let notes = json_of("cwd", &["notes"]);
    assert!(notes
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["path"] == "Note.md"));
}

#[test]
fn the_vault_argument_wins_over_the_current_directory() {
    let args: Vec<String> = ["notes", "--vault", "fixtures/vault", "--json"]
        .map(String::from)
        .to_vec();
    let mut out = Vec::new();
    let cwd = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    execute(&args, &cwd, &data_dir("vaultarg"), &mut out).unwrap();
    let notes: Value = serde_json::from_slice(&out).unwrap();
    assert!(notes
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["path"] == "Note.md"));
}

#[test]
fn notes_json_shape() {
    let notes = json_of("notes", &["notes", "--path", "folder/"]);
    assert_eq!(
        notes,
        json!([
            {"path": "folder/Deep.md", "title": "Deep", "aliases": []},
            {"path": "folder/Twin.md", "title": "Twin", "aliases": []},
        ])
    );
}

#[test]
fn notes_filter_by_tag() {
    let notes = json_of("notes-tag", &["notes", "--tag", "body-tag"]);
    let paths: Vec<&str> = notes
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["Frontmatter.md"]);
}

#[test]
fn notes_text_prints_one_line_per_note() {
    let text = run("notes-text", &["notes", "--path", "folder/"]).unwrap();
    assert_eq!(text, "folder/Deep.md  Deep\nfolder/Twin.md  Twin\n");
}

#[test]
fn tags_json_shape() {
    let tags = json_of("tags", &["tags"]);
    let tag = tags
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["tag"] == "body-tag")
        .unwrap();
    assert_eq!(tag, &json!({"tag": "body-tag", "count": 1}));
}

#[test]
fn search_json_shape_without_highlight_markers() {
    let hits = json_of("search", &["search", "Body"]);
    let hit = hits
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["path"] == "Frontmatter.md")
        .unwrap();
    assert_eq!(hit["title"], "Frontmatter");
    let snippet = &hit["snippets"][0];
    assert!(snippet["line"].as_u64().unwrap() > 0);
    assert!(snippet["text"].as_str().unwrap().contains("Body"));
    assert!(!snippet["text"].as_str().unwrap().contains('\u{1}'));
}

#[test]
fn search_joins_several_words() {
    let text = run("search-words", &["search", "Body", "with"]).unwrap();
    assert!(text.starts_with("Frontmatter.md  Frontmatter\n"), "{text}");
}

#[test]
fn backlinks_json_shape() {
    let links = json_of("backlinks", &["backlinks", "Note"]);
    let from_index = links
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["source"] == "Index.md")
        .unwrap();
    for key in [
        "source", "heading", "block", "alias", "kind", "line", "context",
    ] {
        assert!(from_index.get(key).is_some(), "missing {key}");
    }
    assert!(from_index["context"].as_str().unwrap().contains("[[Note"));
}

#[test]
fn links_json_shape_and_unresolved() {
    let links = json_of("links", &["links", "Index"]);
    let links = links.as_array().unwrap();
    let missing = links.iter().find(|l| l["target"] == "Missing").unwrap();
    assert_eq!(missing["resolved"], Value::Null);
    assert_eq!(missing["kind"], "link");
    let deep = links.iter().find(|l| l["target"] == "Deep").unwrap();
    assert_eq!(deep["resolved"], "folder/Deep.md");
    for key in [
        "target", "heading", "block", "alias", "kind", "resolved", "line",
    ] {
        assert!(deep.get(key).is_some(), "missing {key}");
    }
}

#[test]
fn links_text() {
    let text = run("links-text", &["links", "Index.md"]).unwrap();
    assert!(text.contains("Missing -> (unresolved)\n"), "{text}");
    assert!(text.contains("Deep -> folder/Deep.md\n"), "{text}");
}

#[test]
fn props_json_shape() {
    let props = json_of("props", &["props", "Frontmatter"]);
    let props = props.as_array().unwrap();
    let number = props.iter().find(|p| p["key"] == "number").unwrap();
    assert_eq!(
        number,
        &json!({"key": "number", "type": "number", "value": 42})
    );
    let list = props.iter().find(|p| p["key"] == "list").unwrap();
    assert_eq!(list["value"], json!(["one", "two"]));
}

#[test]
fn props_text() {
    let text = run("props-text", &["props", "Frontmatter"]).unwrap();
    assert!(text.contains("number (number): 42\n"), "{text}");
}

#[test]
fn an_unknown_or_ambiguous_note_fails() {
    assert!(matches!(
        run("nonote", &["props", "Nope"]),
        Err(CliError::Failed(_))
    ));
    assert!(matches!(
        run("ambiguous", &["links", "Twin"]),
        Err(CliError::Failed(_))
    ));
}

#[test]
fn wrong_arguments_are_usage_errors() {
    assert!(matches!(run("u1", &["search"]), Err(CliError::Usage(_))));
    assert!(matches!(run("u2", &["links"]), Err(CliError::Usage(_))));
    assert!(matches!(run("u3", &["tags", "x"]), Err(CliError::Usage(_))));
    assert!(matches!(
        run("u4", &["tags", "--bogus"]),
        Err(CliError::Usage(_))
    ));
}

#[test]
fn the_index_is_updated_before_answering() {
    let base = data_dir("incremental");
    let root = base.join("vault");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("A.md"), "first #one\n").unwrap();
    let ask = |args: &[&str]| {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let mut out = Vec::new();
        execute(&args, &root, &base.join("data"), &mut out).unwrap();
        String::from_utf8(out).unwrap()
    };
    assert_eq!(ask(&["notes"]), "A.md  A\n");
    std::fs::write(root.join("B.md"), "second\n").unwrap();
    std::fs::remove_file(root.join("A.md")).unwrap();
    assert_eq!(ask(&["notes"]), "B.md  B\n");
}

#[test]
fn a_subcommand_answers_quickly_on_a_2000_note_vault() {
    let base = data_dir("perf");
    let root = base.join("vault");
    std::fs::create_dir_all(root.join(".obsidian")).unwrap();
    for i in 0..2000 {
        let dir = root.join(format!("d{}", i % 20));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("n{i}.md")),
            format!(
                "---\ntitle: Note {i}\n---\nbody {i} #t{} [[n{}]]\n",
                i % 10,
                (i + 1) % 2000
            ),
        )
        .unwrap();
    }
    let ask = |args: &[&str]| {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let mut out = Vec::new();
        let start = std::time::Instant::now();
        execute(&args, &root, &base.join("data"), &mut out).unwrap();
        start.elapsed()
    };
    ask(&["tags"]); // first run builds the index
    let took = ask(&["search", "body"]);
    eprintln!("search on 2000 notes: {took:?}");
    // The criterion is 300 ms on a release build; debug builds get headroom.
    let limit = if cfg!(debug_assertions) { 1500 } else { 300 };
    assert!(took.as_millis() < limit, "took {took:?}");
}
