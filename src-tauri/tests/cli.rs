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

// --- `new` and `append` write, so they work on a copy of the vault. ---

use nixe_lib::cli::execute_with;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nixe-cli-w-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("folder")).unwrap();
    std::fs::write(dir.join("folder/Deep.md"), "# Deep\nbody").unwrap();
    std::fs::write(dir.join("Plain.md"), "one\n").unwrap();
    dunce::canonicalize(dir).unwrap()
}

fn write_cmd(name: &str, root: &Path, args: &[&str], stdin: &str) -> Result<String, CliError> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let mut out = Vec::new();
    execute_with(
        &args,
        root,
        &data_dir(name),
        &mut stdin.as_bytes(),
        &mut out,
    )?;
    Ok(String::from_utf8(out).unwrap())
}

#[test]
fn new_creates_a_note_in_the_root_and_prints_its_path() {
    let root = scratch("new");
    let out = write_cmd("new", &root, &["new", "Idea"], "").unwrap();
    assert_eq!(out.trim(), root.join("Idea.md").to_str().unwrap());
    assert_eq!(std::fs::read_to_string(root.join("Idea.md")).unwrap(), "");
    // An existing note is never replaced.
    assert!(write_cmd("new", &root, &["new", "Idea"], "").is_err());
}

#[test]
fn new_uses_the_folder_option_and_the_vault_setting() {
    let root = scratch("new-folder");
    write_cmd("nf", &root, &["new", "A", "--folder", "x/y"], "").unwrap();
    assert!(root.join("x/y/A.md").is_file());
    std::fs::create_dir_all(root.join(".obsidian")).unwrap();
    std::fs::write(
        root.join(".obsidian/app.json"),
        r#"{"newFileLocation":"folder","newFileFolderPath":"Notes"}"#,
    )
    .unwrap();
    write_cmd("nf", &root, &["new", "B"], "").unwrap();
    assert!(root.join("Notes/B.md").is_file());
}

#[test]
fn new_refuses_paths_outside_the_vault() {
    let root = scratch("new-out");
    assert!(write_cmd("no", &root, &["new", "A", "--folder", "../out"], "").is_err());
    assert!(write_cmd("no", &root, &["new", "A", "--folder", "/tmp"], "").is_err());
    assert!(write_cmd("no", &root, &["new", "../A"], "").is_err());
    assert!(!root.parent().unwrap().join("out").exists());
    #[cfg(unix)]
    {
        let outside = scratch("new-outside-target");
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(write_cmd("no", &root, &["new", "A", "--folder", "link"], "").is_err());
        assert!(!outside.join("A.md").exists());
    }
    assert!(matches!(
        write_cmd("no", &root, &["new"], ""),
        Err(CliError::Usage(_))
    ));
}

#[test]
fn append_adds_text_to_an_existing_note_by_name_or_path() {
    let root = scratch("append");
    write_cmd("a", &root, &["append", "Plain", "two", "words"], "").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("Plain.md")).unwrap(),
        "one\ntwo words\n"
    );
    // A unique name resolves like a wikilink; a missing final newline is added first.
    let out = write_cmd("a", &root, &["append", "Deep"], "from stdin\n").unwrap();
    assert_eq!(out.trim(), root.join("folder/Deep.md").to_str().unwrap());
    assert_eq!(
        std::fs::read_to_string(root.join("folder/Deep.md")).unwrap(),
        "# Deep\nbody\nfrom stdin\n"
    );
    write_cmd("a", &root, &["append", "folder/Deep.md", "end"], "").unwrap();
    assert!(std::fs::read_to_string(root.join("folder/Deep.md"))
        .unwrap()
        .ends_with("from stdin\nend\n"));
    assert!(std::fs::read_dir(&root).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".nixe-tmp")));
}

#[test]
fn append_creates_a_missing_note() {
    let root = scratch("append-new");
    write_cmd("an", &root, &["append", "Fresh", "hello"], "").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("Fresh.md")).unwrap(),
        "hello\n"
    );
    write_cmd("an", &root, &["append", "sub/Other", "x"], "").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("sub/Other.md")).unwrap(),
        "x\n"
    );
}

#[test]
fn append_refuses_paths_outside_the_vault_and_empty_text() {
    let root = scratch("append-out");
    assert!(write_cmd("ao", &root, &["append", "../evil", "x"], "").is_err());
    assert!(write_cmd("ao", &root, &["append", "/tmp/evil.md", "x"], "").is_err());
    assert!(matches!(
        write_cmd("ao", &root, &["append", "Plain"], ""),
        Err(CliError::Usage(_))
    ));
    assert!(matches!(
        write_cmd("ao", &root, &["append"], "x"),
        Err(CliError::Usage(_))
    ));
}

#[test]
fn append_inbox_writes_to_the_inbox_folder() {
    let root = scratch("inbox");
    write_cmd("i", &root, &["append", "--inbox", "first"], "").unwrap();
    write_cmd("i", &root, &["append", "--inbox"], "second").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("Inbox/Inbox.md")).unwrap(),
        "first\nsecond\n"
    );
    std::fs::create_dir_all(root.join(".obsidian")).unwrap();
    std::fs::write(
        root.join(".obsidian/app.json"),
        r#"{"newFileLocation":"folder","newFileFolderPath":"Capture"}"#,
    )
    .unwrap();
    write_cmd("i", &root, &["append", "--inbox", "third"], "").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("Capture/Inbox.md")).unwrap(),
        "third\n"
    );
}

mod several_roots {
    use super::*;

    /// Two small vaults named `alpha` and `beta` below a temp directory.
    fn two_vaults(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = data_dir(&format!("{name}-vaults"));
        let (a, b) = (base.join("alpha"), base.join("beta"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("One.md"), "#red\nshared words\n").unwrap();
        std::fs::write(b.join("Two.md"), "#red #blue\nshared more\n").unwrap();
        (base, a, b)
    }

    fn run_in(base: &Path, name: &str, args: &[&str]) -> Result<String, CliError> {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let mut out = Vec::new();
        execute(&args, base, &data_dir(name), &mut out)?;
        Ok(String::from_utf8(out).unwrap())
    }

    #[test]
    fn search_covers_every_vault_and_names_the_root() {
        let (base, _, _) = two_vaults("search");
        let out = run_in(
            &base,
            "search",
            &[
                "search", "shared", "--vault", "alpha", "--vault", "beta", "--json",
            ],
        )
        .unwrap();
        let hits: Value = serde_json::from_str(&out).unwrap();
        let found: Vec<(String, String)> = hits
            .as_array()
            .unwrap()
            .iter()
            .map(|h| {
                (
                    h["root"].as_str().unwrap().into(),
                    h["path"].as_str().unwrap().into(),
                )
            })
            .collect();
        assert!(
            found.contains(&("alpha".into(), "One.md".into())),
            "{found:?}"
        );
        assert!(
            found.contains(&("beta".into(), "Two.md".into())),
            "{found:?}"
        );

        let text = run_in(
            &base,
            "search-text",
            &[
                "search",
                "shared",
                "root:beta",
                "--vault",
                "alpha",
                "--vault",
                "beta",
            ],
        )
        .unwrap();
        assert!(
            text.contains("beta:Two.md") && !text.contains("One.md"),
            "{text}"
        );
    }

    #[test]
    fn tags_add_up_and_notes_name_the_root() {
        let (base, _, _) = two_vaults("tags");
        let out = run_in(
            &base,
            "tags",
            &["tags", "--vault", "alpha", "--vault=beta", "--json"],
        )
        .unwrap();
        let tags: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(tags[0], json!({"tag": "red", "count": 2}));
        assert_eq!(tags[1], json!({"tag": "blue", "count": 1}));

        let out = run_in(
            &base,
            "notes",
            &["notes", "--vault", "alpha", "--vault", "beta", "--json"],
        )
        .unwrap();
        let notes: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(notes[0]["root"], "alpha");
        assert_eq!(notes[0]["path"], "One.md");
        assert_eq!(notes[1]["root"], "beta");
    }

    #[test]
    fn a_saved_workspace_names_the_roots() {
        let (base, a, b) = two_vaults("ws");
        let data = data_dir("ws-data");
        let mut ws = nixe_lib::workspace::Workspace::new("both").unwrap();
        ws.add_root(&a).unwrap();
        ws.add_root(&b).unwrap();
        nixe_lib::workspace::save(&data, &ws).unwrap();
        let args: Vec<String> = ["search", "shared", "--workspace", "both"]
            .map(String::from)
            .into();
        let mut out = Vec::new();
        execute(&args, &base, &data, &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains("alpha:One.md") && text.contains("beta:Two.md"),
            "{text}"
        );

        let missing: Vec<String> = ["search", "x", "--workspace", "nope"]
            .map(String::from)
            .into();
        assert!(matches!(
            execute(&missing, &base, &data, &mut Vec::new()),
            Err(CliError::Failed(_))
        ));
        let both: Vec<String> = ["search", "x", "--workspace", "both", "--vault", "alpha"]
            .map(String::from)
            .into();
        assert!(matches!(
            execute(&both, &base, &data, &mut Vec::new()),
            Err(CliError::Usage(_))
        ));
    }

    #[test]
    fn commands_about_one_note_refuse_several_vaults() {
        let (base, _, _) = two_vaults("one");
        for args in [
            &["backlinks", "One", "--vault", "alpha", "--vault", "beta"][..],
            &["check", "--vault", "alpha", "--vault", "beta"][..],
            &["daily", "--vault", "alpha", "--vault", "beta"][..],
        ] {
            let err = run_in(&base, "one", args).unwrap_err();
            assert!(matches!(err, CliError::Usage(_)), "{args:?}: {err:?}");
        }
    }
}
