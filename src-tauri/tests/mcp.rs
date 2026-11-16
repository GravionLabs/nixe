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
