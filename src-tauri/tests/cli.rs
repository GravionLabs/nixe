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
            "several-search",
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
            "several-search-text",
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
            "several-notes",
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
        ws.add_root(&a, &nixe_lib::workspace::Locations::default())
            .unwrap();
        ws.add_root(&b, &nixe_lib::workspace::Locations::default())
            .unwrap();
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
            let err = run_in(&base, "several-one", args).unwrap_err();
            assert!(matches!(err, CliError::Usage(_)), "{args:?}: {err:?}");
        }
    }
}

fn export(name: &str, args: &[&str]) -> Result<nixe_lib::cli_export::ExportRequest, CliError> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    nixe_lib::cli::parse_export(&args, &vault(), &data_dir(name), true)
}

#[test]
fn export_resolves_the_note_like_a_wikilink() {
    let r = export(
        "export",
        &["Note", "--format", "html", "--out", "o/note.html"],
    )
    .unwrap();
    assert!(r.note.ends_with("fixtures/vault/Note.md"));
    assert!(r.out.unwrap().ends_with("fixtures/vault/o/note.html"));
    assert!(r.headless);
    assert!(export("export-pdf", &["Note", "--format", "pdf"])
        .unwrap()
        .out
        .is_none());
}

#[test]
fn export_needs_a_format_and_an_existing_note() {
    assert!(matches!(
        export("export-nf", &["Note"]),
        Err(CliError::Usage(_))
    ));
    assert!(matches!(
        export("export-no", &["Nope", "--format", "html"]),
        Err(CliError::Failed(_))
    ));
}

mod site {
    use super::*;
    use std::collections::BTreeSet;
    use std::fs;

    fn export(name: &str, args: &[&str]) -> (PathBuf, Result<String, CliError>) {
        let out = std::env::temp_dir().join(format!("nixe-site-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&out);
        let mut all = vec!["export"];
        all.extend_from_slice(args);
        let out_arg = out.to_string_lossy().into_owned();
        all.extend(["--site", &out_arg]);
        (out, run(name, &all))
    }

    fn pages(dir: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut todo = vec![dir.to_path_buf()];
        while let Some(d) = todo.pop() {
            for e in fs::read_dir(d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    todo.push(p);
                } else if p.extension().is_some_and(|x| x == "html") {
                    found.push(p);
                }
            }
        }
        found.sort();
        found
    }

    fn decode(s: &str) -> String {
        let mut out = Vec::new();
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }

    /// Every `href` and `src` of the page that is not an address on the web.
    fn internal(html: &str) -> Vec<String> {
        let mut found = Vec::new();
        for attr in ["href=\"", "src=\""] {
            for part in html.split(attr).skip(1) {
                let value = part.split('"').next().unwrap();
                if !value.contains("://") && !value.starts_with("mailto:") {
                    found.push(value.to_string());
                }
            }
        }
        found
    }

    fn ids(html: &str) -> BTreeSet<String> {
        html.split("id=\"")
            .skip(1)
            .map(|p| p.split('"').next().unwrap().to_string())
            .collect()
    }

    #[test]
    fn every_internal_link_of_the_exported_vault_resolves() {
        let (out, result) = export("vault", &["."]);
        assert!(result.unwrap().contains("pages"));
        let files = pages(&out);
        assert!(files.len() > 8);
        let mut checked = 0;
        for page in &files {
            let html = fs::read_to_string(page).unwrap();
            for link in internal(&html) {
                let (path, fragment) = link.split_once('#').unwrap_or((&link, ""));
                let target = if path.is_empty() {
                    page.clone()
                } else {
                    page.parent().unwrap().join(decode(path))
                };
                assert!(target.is_file(), "{}: {link}", page.display());
                // The fixture links `Deep.md#Top` to a heading that does not exist; a heading
                // the note has must be found by its anchor.
                if fragment == "second-heading" {
                    assert!(ids(&fs::read_to_string(&target).unwrap()).contains(fragment));
                }
                checked += 1;
            }
        }
        assert!(checked > 50);
    }

    #[test]
    fn a_page_has_wikilinks_a_navigation_tree_backlinks_and_the_search() {
        let (out, result) = export("parts", &["."]);
        result.unwrap();
        let index = fs::read_to_string(out.join("index.html")).unwrap();
        assert!(index.contains("<a class=\"wikilink\" href=\"Note.html\">Note</a>"));
        assert!(index.contains("href=\"Note.html#second-heading\""));
        assert!(index.contains("href=\"folder/Deep.html\""));
        // Missing and ambiguous targets stay text.
        assert!(index.contains("<span class=\"unpublished\">Missing</span>"));
        assert!(index.contains("<span class=\"unpublished\">Twin</span>"));
        assert!(index.contains("<nav"));
        let note = fs::read_to_string(out.join("Note.html")).unwrap();
        assert!(note.contains("class=\"backlinks\""));
        assert!(note.contains("href=\"index.html\""));
        let deep = fs::read_to_string(out.join("folder/Deep.html")).unwrap();
        assert!(deep.contains("href=\"../_nixe/site.css\""));
        let search = fs::read_to_string(out.join("_nixe/search-index.js")).unwrap();
        assert!(search.starts_with("window.NIXE_SEARCH = ["));
        assert!(out.join("_nixe/search.js").is_file());
        let home = fs::read_to_string(out.join("index.html")).unwrap();
        assert!(
            home.contains("Vault index"),
            "the note Index is the home page"
        );
        assert!(
            out.join("assets/image.svg").is_file(),
            "a shown image is copied"
        );
        // No script of a note and nothing that needs a server.
        for page in pages(&out) {
            let html = fs::read_to_string(page).unwrap();
            assert_eq!(html.matches("<script").count(), 2);
            assert!(!html.contains("href=\"/"), "root-absolute link");
        }
    }

    #[test]
    fn a_folder_or_a_frontmatter_property_excludes_a_note_and_its_links_become_text() {
        let dir = std::env::temp_dir().join(format!("nixe-site-src-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("private")).unwrap();
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        fs::write(
            dir.join("Home.md"),
            "[[Secret]] [[Hidden]] [[Open]] [md](private/Hidden.md) [k](private/key.txt) [o](.obsidian/app.json) ![[private/key.txt]] <script>x()</script>\n",
        )
        .unwrap();
        fs::write(
            dir.join("Open.md"),
            "open\n```sh\nif [[ -f x ]]; then 100%%d%%\n```\n",
        )
        .unwrap();
        fs::write(dir.join("private/key.txt"), "k").unwrap();
        fs::write(dir.join(".obsidian/app.json"), "{}").unwrap();
        fs::write(dir.join("Secret.md"), "---\npublish: false\n---\nsecret\n").unwrap();
        fs::write(dir.join("private/Hidden.md"), "hidden\n").unwrap();
        let out = dir.join("out");
        let args: Vec<String> = [
            "export",
            ".",
            "--site",
            "out",
            "--exclude",
            "private",
            "--vault",
            ".",
        ]
        .map(String::from)
        .to_vec();
        let mut sink = Vec::new();
        execute(&args, &dir, &data_dir("exclude"), &mut sink).unwrap();
        let home = fs::read_to_string(out.join("Home.html")).unwrap();
        assert!(home.contains("<span class=\"unpublished\">Secret</span>"));
        assert!(home.contains("<span class=\"unpublished\">Hidden</span>"));
        assert!(home.contains("href=\"Open.html\""));
        assert!(!home.contains("Hidden.html"));
        assert!(home.contains("&lt;script&gt;"), "raw HTML is shown as text");
        assert!(!out.join("Secret.html").exists());
        assert!(!out.join("private").exists());
        assert!(!out.join("_nixe/files").exists());
        assert!(!out.join(".obsidian").exists());
        let open = fs::read_to_string(out.join("Open.html")).unwrap();
        assert!(
            open.contains("if [[ -f x ]]; then 100%%d%%"),
            "code is left alone"
        );
        let search = fs::read_to_string(out.join("_nixe/search-index.js")).unwrap();
        assert!(!search.contains("secret") && !search.contains("hidden"));
        assert!(String::from_utf8(sink).unwrap().contains("2 left out"));
    }

    #[test]
    fn a_site_of_a_subfolder_uses_relative_links_only() {
        let (out, result) = export("sub", &["folder"]);
        result.unwrap();
        let deep = fs::read_to_string(out.join("Deep.html")).unwrap();
        assert!(deep.contains("href=\"_nixe/site.css\""));
        assert!(!deep.contains("../"));
    }

    #[test]
    fn wrong_arguments_are_usage_errors() {
        let (_, r) = export("both", &[".", "--format", "html"]);
        assert!(matches!(r, Err(CliError::Usage(_))));
        let (_, r) = export("two", &[".", "folder"]);
        assert!(matches!(r, Err(CliError::Usage(_))));
        let (_, r) = export("missing", &["nope"]);
        assert!(matches!(r, Err(CliError::Failed(_))));
    }
}

#[cfg(desktop)]
mod clip {
    use super::*;

    fn page(name: &str) -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/web")
            .join(name)
            .to_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn clip_reads_the_html_from_stdin_and_prints_the_path() {
        let root = scratch("clip-stdin");
        let html = std::fs::read_to_string(page("article.html")).unwrap();
        let out = write_cmd(
            "clip-stdin",
            &root,
            &[
                "clip",
                "https://example.com/a",
                "--tag",
                "reading",
                "--tag=web",
                "--html",
                "-",
            ],
            &html,
        )
        .unwrap();
        let path = root.join("Links/Keeping notes as plain files.md");
        assert_eq!(out.trim(), path.to_str().unwrap());
        let text = std::fs::read_to_string(path).unwrap();
        assert!(text.contains("tags:\n  - reading\n  - web\n"));
    }

    #[test]
    fn clip_of_a_saved_url_prints_exists_and_json_says_not_created() {
        let root = scratch("clip-twice");
        let file = page("article.html");
        let first = write_cmd(
            "clip-twice",
            &root,
            &[
                "clip",
                "https://example.com/a?utm_source=x",
                "--html",
                &file,
            ],
            "",
        )
        .unwrap();
        let path = root.join("Links/Keeping notes as plain files.md");
        assert_eq!(first.trim(), path.to_str().unwrap());
        // The page names its own canonical address: clip of another page that has the same one.
        let text = std::fs::read_to_string(&path).unwrap();
        let url = text
            .lines()
            .find_map(|l| l.strip_prefix("url: "))
            .unwrap()
            .to_string();
        let out = write_cmd(
            "clip-twice",
            &root,
            &[
                "clip",
                &format!("{}/#top", url.to_uppercase().replace("HTTPS", "https")),
                "--html",
                &file,
            ],
            "",
        )
        .unwrap();
        assert_eq!(out.trim(), format!("exists: {}", path.display()));
        let json = write_cmd(
            "clip-twice",
            &root,
            &["clip", &url, "--html", &file, "--json"],
            "",
        )
        .unwrap();
        let json: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            json,
            json!({"path": path.to_str().unwrap(), "created": false})
        );
    }

    #[test]
    fn clip_json_names_path_and_created_and_takes_folder_title_and_file() {
        let root = scratch("clip-json");
        let out = write_cmd(
            "clip-json",
            &root,
            &[
                "clip",
                "https://example.com/a",
                "--html",
                &page("article.html"),
                "--folder",
                "Reading/Later",
                "--title",
                "Mine",
                "--json",
            ],
            "",
        )
        .unwrap();
        let json: Value = serde_json::from_str(&out).unwrap();
        let path = root.join("Reading/Later/Mine.md");
        assert_eq!(
            json,
            json!({"path": path.to_str().unwrap(), "created": true})
        );
        assert!(path.is_file());
    }

    #[test]
    fn clip_refuses_wrong_arguments_and_folders_outside_the_vault() {
        let root = scratch("clip-bad");
        let run = |args: &[&str]| write_cmd("clip-bad", &root, args, "<title>T</title>");
        assert!(matches!(run(&["clip"]), Err(CliError::Usage(_))));
        assert!(matches!(
            run(&["clip", "a", "b", "--html", "-"]),
            Err(CliError::Usage(_))
        ));
        assert!(matches!(
            run(&["clip", "notaurl", "--html", "-"]),
            Err(CliError::Failed(_))
        ));
        assert!(run(&[
            "clip",
            "https://x.test/",
            "--html",
            "-",
            "--folder",
            "../out"
        ])
        .is_err());
        assert!(run(&["clip", "https://x.test/", "--html", "missing.html"]).is_err());
    }
}
