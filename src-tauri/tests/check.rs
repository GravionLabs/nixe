//! `nixe check` and the health report against `fixtures/vault/` and generated vaults.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use nixe_lib::cli::{execute, CliError};
use serde_json::Value;

// The same guard as the unit tests use: the directory is removed when it drops, also on a panic.
#[allow(dead_code)]
#[path = "../src/test_dir.rs"]
mod test_dir;
use test_dir::TestDir;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/vault")
}

fn temp(name: &str) -> TestDir {
    TestDir::new(&format!("nixe-check-{name}-"))
}

/// Runs `nixe check` on `vault`; the text on stdout and the exit-code-relevant result.
fn check(name: &str, vault: &Path, extra: &[&str]) -> (String, Result<(), CliError>) {
    let mut args: Vec<String> = vec![
        "check".into(),
        "--vault".into(),
        vault.display().to_string(),
    ];
    args.extend(extra.iter().map(|a| a.to_string()));
    let mut out = Vec::new();
    let result = execute(&args, vault, &temp(name), &mut out);
    (String::from_utf8(out).unwrap(), result)
}

fn report(name: &str, vault: &Path, extra: &[&str]) -> Value {
    let mut extra = extra.to_vec();
    extra.push("--json");
    serde_json::from_str(&check(name, vault, &extra).0).unwrap()
}

fn strings(v: &Value) -> Vec<&str> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect()
}

#[test]
fn brokenLinks_name_the_note_the_line_and_the_target() {
    let r = report("broken", &fixture(), &[]);
    let links = r["brokenLinks"].as_array().unwrap();
    let find = |source: &str, target: &str| {
        links
            .iter()
            .find(|l| l["source"] == source && l["target"] == target)
            .unwrap_or_else(|| panic!("{source} -> {target} not reported"))
    };
    let missing = find("Index.md", "Missing");
    assert_eq!(missing["line"], 8);
    assert_eq!(missing["kind"], "link");
    assert!(missing["context"].as_str().unwrap().contains("[[Missing]]"));
    assert_eq!(find("Embeds.md", "Nope")["kind"], "embed");
    // An ambiguous name cannot be resolved either.
    find("Index.md", "Twin");
    // Resolved links are not reported.
    assert!(!links.iter().any(|l| l["target"] == "Note"));
}

#[test]
fn orphans_have_no_links_in_or_out() {
    let r = report("orphans", &fixture(), &[]);
    let orphans: Vec<&str> = r["orphans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["path"].as_str().unwrap())
        .collect();
    assert!(orphans.contains(&"Frontmatter.md"));
    assert!(orphans.contains(&"folder/Twin.md"));
    // Linked from Index, or linking out.
    assert!(!orphans.contains(&"Note.md"));
    assert!(!orphans.contains(&"Index.md"));
    assert!(!orphans.contains(&"Loop A.md"));
}

#[test]
fn duplicate_basenames_are_grouped() {
    let r = report("dupes", &fixture(), &[]);
    let groups = r["duplicates"].as_array().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0]["name"], "Twin");
    assert_eq!(
        strings(&groups[0]["paths"]),
        ["folder/Twin.md", "other/Twin.md"]
    );
}

#[test]
fn used_attachments_are_not_reported_and_unused_ones_are() {
    // The fixture embeds both of its attachments.
    assert!(report("att-fixture", &fixture(), &[])["unusedAttachments"]
        .as_array()
        .unwrap()
        .is_empty());

    let vault = temp("att-vault");
    fs::create_dir_all(vault.join("assets")).unwrap();
    fs::write(vault.join("A.md"), "![[used.png]] [[B]]\n").unwrap();
    fs::write(vault.join("B.md"), "[[A]]\n").unwrap();
    fs::write(vault.join("assets/used.png"), "x").unwrap();
    fs::write(vault.join("assets/unused.png"), "x").unwrap();
    fs::create_dir_all(vault.join(".hidden")).unwrap();
    fs::write(vault.join(".hidden/x.json"), "{}").unwrap();
    let r = report("att", &vault, &[]);
    assert_eq!(strings(&r["unusedAttachments"]), ["assets/unused.png"]);
    assert!(r["brokenLinks"].as_array().unwrap().is_empty());
}

#[test]
fn excluded_folders_and_daily_notes_are_left_out() {
    let vault = temp("exclude");
    for dir in ["templates", "archive", "daily"] {
        fs::create_dir_all(vault.join(dir)).unwrap();
    }
    fs::write(vault.join("Home.md"), "[[Real]]\n").unwrap();
    fs::write(vault.join("Real.md"), "[[Home]]\n").unwrap();
    fs::write(vault.join("lonely.md"), "alone\n").unwrap();
    fs::write(vault.join("daily/2026-11-16.md"), "today\n").unwrap();
    fs::write(vault.join("templates/T.md"), "[[{{title}}]] [[Real]]\n").unwrap();
    fs::write(vault.join("archive/old.md"), "[[gone]]\n").unwrap();
    fs::write(vault.join("archive/Home.md"), "dup\n").unwrap();
    fs::write(vault.join("archive/pic.png"), "x").unwrap();

    let all = report("excl-all", &vault, &[]);
    assert_eq!(all["brokenLinks"].as_array().unwrap().len(), 2);
    assert_eq!(all["duplicates"].as_array().unwrap().len(), 1);
    assert_eq!(strings(&all["unusedAttachments"]), ["archive/pic.png"]);
    let paths: Vec<&str> = all["orphans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["path"].as_str().unwrap())
        .collect();
    // Daily notes never count as orphans.
    assert!(!paths.contains(&"daily/2026-11-16.md"));
    assert!(paths.contains(&"lonely.md"));

    let kept = report(
        "excl",
        &vault,
        &["--exclude", "templates", "--exclude=archive/"],
    );
    assert!(kept["brokenLinks"].as_array().unwrap().is_empty());
    assert!(kept["duplicates"].as_array().unwrap().is_empty());
    assert!(kept["unusedAttachments"].as_array().unwrap().is_empty());
    let paths: Vec<&str> = kept["orphans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["lonely.md"]);
}

#[test]
fn exit_is_1_with_brokenLinks_and_0_without() {
    let (text, result) = check("exit-bad", &fixture(), &[]);
    assert_eq!(result, Err(CliError::Failed("4 broken link(s)".into())));
    assert!(text.contains("Broken links (4)"));
    assert!(text.contains("Index.md:8  - [[Missing]] stays unresolved"));
    assert!(text.contains("Twin: folder/Twin.md, other/Twin.md"));

    // The JSON report is printed, too.
    let (json, result) = check("exit-json", &fixture(), &["--json"]);
    assert!(result.is_err());
    assert!(serde_json::from_str::<Value>(&json).is_ok());

    let vault = temp("exit-ok");
    fs::write(vault.join("A.md"), "[[B]]\n").unwrap();
    fs::write(vault.join("B.md"), "[[A]]\n").unwrap();
    let (text, result) = check("exit-ok-run", &vault, &[]);
    assert_eq!(result, Ok(()));
    assert!(text.contains("Broken links (0)"));
}

#[test]
fn check_takes_no_positional_argument() {
    let (_, result) = check("usage", &fixture(), &["stray"]);
    assert!(matches!(result, Err(CliError::Usage(_))));
}

#[test]
fn the_report_of_2000_notes_takes_under_a_second_from_the_index() {
    let vault = temp("perf");
    for i in 0..2000 {
        let next = (i + 1) % 2000;
        let body = format!("[[note {next}]] [[missing {i}]] ![[img {}.png]]\n", i % 50);
        fs::write(vault.join(format!("note {i}.md")), body).unwrap();
    }
    for i in 0..100 {
        fs::write(vault.join(format!("img {i}.png")), "x").unwrap();
    }
    let data = temp("perf-data");
    let args: Vec<String> = ["check", "--json"].map(String::from).to_vec();
    // The first run builds the index; the report itself is timed on the second.
    let _ = execute(&args, &vault, &data, &mut Vec::new());
    let start = Instant::now();
    let mut out = Vec::new();
    let _ = execute(&args, &vault, &data, &mut out);
    let elapsed = start.elapsed();
    let r: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(r["brokenLinks"].as_array().unwrap().len(), 2000);
    assert_eq!(r["unusedAttachments"].as_array().unwrap().len(), 50);
    assert!(elapsed.as_millis() < 1000, "took {elapsed:?}");
}
