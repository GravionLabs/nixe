//! `nixe mcp` end to end: the real binary is started over stdio, its tools are listed and each
//! one is called against `fixtures/vault/`. The index goes to a temp directory.

use std::path::{Path, PathBuf};

use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::service::RunningService;
use rmcp::transport::{ConfigureCommandExt, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};
use tokio::process::Command;

fn vault() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/vault")
}

type Client = RunningService<RoleClient, ()>;

async fn start(name: &str) -> Client {
    let data = std::env::temp_dir().join(format!("nixe-mcp-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let transport =
        TokioChildProcess::new(Command::new(env!("CARGO_BIN_EXE_nixe")).configure(|cmd| {
            // Where the app data directory resolves to on each platform.
            cmd.env("HOME", &data)
                .env("XDG_DATA_HOME", &data)
                .env("APPDATA", &data)
                .arg("mcp")
                .arg("--vault")
                .arg(vault());
        }))
        .unwrap();
    ().serve(transport).await.unwrap()
}

async fn call(client: &Client, tool: &'static str, args: Value) -> Result<Value, String> {
    let args = args.as_object().cloned().unwrap_or_default();
    let result: CallToolResult = client
        .call_tool(CallToolRequestParams::new(tool).with_arguments(args))
        .await
        .map_err(|e| e.to_string())?;
    let text = result
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect::<String>();
    if result.is_error == Some(true) {
        return Err(text);
    }
    Ok(serde_json::from_str(&text).unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_the_seven_read_only_tools() {
    let client = start("list").await;
    let tools = client.list_all_tools().await.unwrap();
    let mut names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "backlinks",
            "notes_by_property",
            "outgoing_links",
            "read_note",
            "resolve_link",
            "search",
            "tags"
        ]
    );
    for tool in &tools {
        let hint = tool.annotations.as_ref().and_then(|a| a.read_only_hint);
        assert_eq!(hint, Some(true), "{} is not read-only", tool.name);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_tool_answers_against_the_fixture_vault() {
    let client = start("calls").await;

    let hits = call(&client, "search", json!({"query": "body-tag"}))
        .await
        .unwrap();
    assert!(hits
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h["path"] == "Frontmatter.md"));

    let back = call(&client, "backlinks", json!({"note": "Note"}))
        .await
        .unwrap();
    assert!(back
        .as_array()
        .unwrap()
        .iter()
        .any(|b| b["source"] == "Index.md"));

    let out = call(&client, "outgoing_links", json!({"note": "Index.md"}))
        .await
        .unwrap();
    assert!(out
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l["resolved"] == "Note.md"));

    let tags = call(&client, "tags", json!({})).await.unwrap();
    assert!(tags
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["tag"] == "body-tag"));

    let by_prop = call(
        &client,
        "notes_by_property",
        json!({"key": "list", "value": "two"}),
    )
    .await
    .unwrap();
    assert_eq!(
        by_prop,
        json!([{"path": "Frontmatter.md", "title": "Frontmatter", "value": ["one", "two"]}])
    );
    let any_value = call(&client, "notes_by_property", json!({"key": "number"}))
        .await
        .unwrap();
    assert_eq!(any_value[0]["value"], json!(42));

    let note = call(&client, "read_note", json!({"note": "folder/Deep"}))
        .await
        .unwrap();
    assert_eq!(note["path"], "folder/Deep.md");
    assert_eq!(
        note["content"],
        std::fs::read_to_string(vault().join("folder/Deep.md")).unwrap()
    );

    let found = call(&client, "resolve_link", json!({"target": "Deep"}))
        .await
        .unwrap();
    assert_eq!(found, json!({"path": "folder/Deep.md"}));
    let missing = call(&client, "resolve_link", json!({"target": "Nope"}))
        .await
        .unwrap();
    assert_eq!(missing, json!({"path": null}));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_path_outside_the_vault_is_refused() {
    let client = start("outside").await;
    for (tool, args) in [
        ("read_note", json!({"note": "../Cargo.toml"})),
        ("read_note", json!({"note": "/etc/passwd"})),
        ("backlinks", json!({"note": "../README.md"})),
        ("outgoing_links", json!({"note": "folder/../../x.md"})),
        ("resolve_link", json!({"target": "../x"})),
    ] {
        let err = call(&client, tool, args.clone()).await.unwrap_err();
        assert!(err.contains("outside the vault"), "{tool} {args}: {err}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn results_hold_vault_relative_paths_only() {
    let client = start("relative").await;
    let notes = call(&client, "notes_by_property", json!({"key": "title"}))
        .await
        .unwrap();
    let vault = vault().canonicalize().unwrap();
    let text = notes.to_string();
    assert!(!text.contains(vault.to_str().unwrap()));
    for n in notes.as_array().unwrap() {
        assert!(!Path::new(n["path"].as_str().unwrap()).is_absolute());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn several_vaults_are_searched_together() {
    let base = std::env::temp_dir().join(format!("nixe-mcp-roots-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let (a, b) = (base.join("alpha"), base.join("beta"));
    for (dir, file, text) in [
        (&a, "One.md", "#red\nshared words"),
        (&b, "Two.md", "#blue\nshared more"),
    ] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(file), text).unwrap();
    }
    let data = base.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let transport =
        TokioChildProcess::new(Command::new(env!("CARGO_BIN_EXE_nixe")).configure(|cmd| {
            cmd.env("HOME", &data)
                .env("XDG_DATA_HOME", &data)
                .env("APPDATA", &data)
                .arg("mcp")
                .arg("--vault")
                .arg(&a)
                .arg("--vault")
                .arg(&b);
        }))
        .unwrap();
    let client: Client = ().serve(transport).await.unwrap();

    let hits = call(&client, "search", json!({"query": "shared"}))
        .await
        .unwrap();
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

    let only = call(&client, "search", json!({"query": "shared root:beta"}))
        .await
        .unwrap();
    assert_eq!(only.as_array().unwrap().len(), 1);
    let only = call(
        &client,
        "search",
        json!({"query": "shared", "roots": ["alpha"]}),
    )
    .await
    .unwrap();
    assert_eq!(only[0]["root"], "alpha");

    let tags = call(&client, "tags", json!({})).await.unwrap();
    assert_eq!(tags.as_array().unwrap().len(), 2);

    // A tool about one note needs the root once there are several.
    let err = call(&client, "read_note", json!({"note": "One"}))
        .await
        .unwrap_err();
    assert!(err.contains("name the root"), "{err}");
    let note = call(&client, "read_note", json!({"note": "Two", "root": "beta"}))
        .await
        .unwrap();
    assert_eq!(note["path"], "Two.md");
    let err = call(&client, "read_note", json!({"note": "One", "root": "nope"}))
        .await
        .unwrap_err();
    assert!(err.contains("no such root"), "{err}");
}

/// A temp vault and a server over it, with `extra` arguments after `mcp --vault`.
async fn start_clip(name: &str, extra: &[&str]) -> (Client, PathBuf) {
    let base = std::env::temp_dir().join(format!("nixe-mcp-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let (vault, data) = (base.join("vault"), base.join("data"));
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(vault.join("Plain.md"), "plain").unwrap();
    let transport =
        TokioChildProcess::new(Command::new(env!("CARGO_BIN_EXE_nixe")).configure(|cmd| {
            cmd.env("HOME", &data)
                .env("XDG_DATA_HOME", &data)
                .env("APPDATA", &data)
                .arg("mcp")
                .arg("--vault")
                .arg(&vault)
                .args(extra);
        }))
        .unwrap();
    (().serve(transport).await.unwrap(), vault)
}

/// Serves one page on a local port for as many requests as come.
fn serve_page(html: &'static str) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                html.len()
            );
        }
    });
    format!("http://127.0.0.1:{port}/page")
}

#[tokio::test(flavor = "multi_thread")]
async fn clip_link_exists_only_with_the_flag() {
    let (without, _) = start_clip("clip-off", &[]).await;
    let names: Vec<String> = without
        .list_all_tools()
        .await
        .unwrap()
        .iter()
        .map(|t| t.name.to_string())
        .collect();
    assert!(!names.contains(&"clip_link".to_string()), "{names:?}");
    let err = call(
        &without,
        "clip_link",
        json!({"url": "https://example.test/"}),
    )
    .await
    .unwrap_err();
    assert!(!err.is_empty());

    let (with, _) = start_clip("clip-on", &["--allow-clip"]).await;
    let tools = with.list_all_tools().await.unwrap();
    let tool = tools.iter().find(|t| t.name == "clip_link").unwrap();
    let ann = tool.annotations.as_ref().unwrap();
    assert_eq!(ann.read_only_hint, Some(false));
    assert_eq!(ann.destructive_hint, Some(false));
    assert_eq!(tools.len(), 8);
}

#[tokio::test(flavor = "multi_thread")]
async fn clip_link_creates_a_note_then_returns_it_and_search_sees_it() {
    let (client, vault) = start_clip("clip-new", &["--allow-clip"]).await;
    let url = serve_page(
        "<html><head><title>Zebrafinch notes</title></head><body><article><p>Quokka facts \
         and some more readable words so that the reader keeps this text around.</p></article></body></html>",
    );
    let made = call(&client, "clip_link", json!({"url": url, "tags": ["bird"]}))
        .await
        .unwrap();
    assert_eq!(made["created"], true);
    let path = made["path"].as_str().unwrap().to_string();
    assert!(
        path.starts_with("Links/") && !Path::new(&path).is_absolute(),
        "{path}"
    );
    let text = std::fs::read_to_string(vault.join(&path)).unwrap();
    assert!(text.contains("type: link"), "{text}");

    let hits = call(&client, "search", json!({"query": "Zebrafinch"}))
        .await
        .unwrap();
    assert!(hits
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h["path"] == path.as_str()));

    // The same URL again returns the note and changes nothing.
    let again = call(&client, "clip_link", json!({"url": url, "title": "Other"}))
        .await
        .unwrap();
    assert_eq!(again["created"], false);
    assert_eq!(again["path"], path.as_str());
    assert_eq!(std::fs::read_to_string(vault.join(&path)).unwrap(), text);
    assert_eq!(std::fs::read_dir(vault.join("Links")).unwrap().count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn clip_link_refuses_a_folder_outside_the_links_folder() {
    let (client, vault) = start_clip("clip-folder", &["--allow-clip"]).await;
    let url = "https://example.test/never-fetched";
    for folder in ["Notes", "../x", "/tmp", "Links2", "."] {
        let err = call(&client, "clip_link", json!({"url": url, "folder": folder}))
            .await
            .unwrap_err();
        assert!(
            err.contains("outside the links folder") || err.contains("outside the vault"),
            "{folder}: {err}"
        );
    }
    assert!(!vault.join("Notes").exists());
    let err = call(&client, "clip_link", json!({"url": "ftp://x"}))
        .await
        .unwrap_err();
    assert!(err.contains("http"), "{err}");
}
