//! Read-only vault queries from the command line: `nixe search`, `backlinks`, `links`, `tags`,
//! `notes` and `props`. They open no window: `try_run` answers before Tauri starts.
//! The index is the one the app uses; it is brought up to date (incremental scan) first.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::index::{self, read, scan, search};
use crate::vault::{find_vault_root, resolve::resolve_link};

const SUBCOMMANDS: &[&str] = &[
    "search",
    "backlinks",
    "links",
    "tags",
    "notes",
    "props",
    "check",
    "new",
    "append",
    "daily",
    "mcp",
];

/// Matches `identifier` of `tauri.conf.json`: the app data directory holds the index.
const APP_IDENTIFIER: &str = "dev.nixe.app";

pub const USAGE: &str = "\
usage: nixe <path>|-                       open the viewer
       nixe search <query> [--vault <dir>] [--json]
       nixe backlinks <note> [--vault <dir>] [--json]
       nixe links <note> [--vault <dir>] [--json]
       nixe tags [--vault <dir>] [--json]
       nixe notes [--tag <tag>]... [--path <prefix>] [--vault <dir>] [--json]
       nixe props <note> [--vault <dir>] [--json]
       nixe check [--exclude <dir>]... [--vault <dir>] [--json]   exit 1 on broken links
       nixe new <title> [--folder <dir>] [--open] [--vault <dir>]
       nixe append <note> [text] [--vault <dir>]   text from stdin when omitted
       nixe append --inbox [text] [--vault <dir>]
       nixe daily [--append <text>] [--vault <dir>]   open today's daily note, or append to it
       nixe mcp [--vault <dir>]                   MCP server over stdio (read-only)";

/// Runs the subcommand named by the process arguments. `None` when they name none (the viewer
/// starts); otherwise the exit code, after the answer went to stdout and errors to stderr.
pub fn try_run() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !is_subcommand(&args) {
        return None;
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let Some(data) = app_data_dir() else {
        eprintln!("nixe: cannot locate the application data directory");
        return Some(1);
    };
    if args[0] == "mcp" {
        return Some(match crate::mcp::run(&args[1..], &cwd, &data) {
            Ok(()) => 0,
            Err(CliError::Usage(msg)) => {
                eprintln!("nixe: {msg}\n{USAGE}");
                2
            }
            Err(CliError::Failed(msg)) => {
                eprintln!("nixe: {msg}");
                1
            }
        });
    }
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let code = match execute(&args, &cwd, &data, &mut out) {
        Ok(()) => 0,
        Err(CliError::Usage(msg)) => {
            eprintln!("nixe: {msg}\n{USAGE}");
            2
        }
        Err(CliError::Failed(msg)) => {
            eprintln!("nixe: {msg}");
            1
        }
    };
    // A closed pipe (`nixe tags | head`) is not an error worth reporting.
    let _ = out.flush();
    Some(code)
}

/// True when the first argument names a subcommand.
pub fn is_subcommand(args: &[String]) -> bool {
    args.first()
        .is_some_and(|a| SUBCOMMANDS.contains(&a.as_str()))
}

#[derive(Debug, PartialEq, Eq)]
pub enum CliError {
    /// Wrong arguments; the exit code is 2.
    Usage(String),
    /// The query could not be answered; the exit code is 1.
    Failed(String),
}

impl From<rusqlite::Error> for CliError {
    fn from(e: rusqlite::Error) -> Self {
        CliError::Failed(format!("index: {e}"))
    }
}

/// Where the app keeps its data, without a running app (the same place Tauri resolves).
fn app_data_dir() -> Option<PathBuf> {
    let var = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    if cfg!(target_os = "macos") {
        var("HOME").map(|h| h.join("Library/Application Support").join(APP_IDENTIFIER))
    } else if cfg!(windows) {
        var("APPDATA").map(|d| d.join(APP_IDENTIFIER))
    } else {
        var("XDG_DATA_HOME")
            .or_else(|| var("HOME").map(|h| h.join(".local/share")))
            .map(|d| d.join(APP_IDENTIFIER))
    }
}

#[derive(Debug, Default)]
struct Parsed {
    vault: Option<String>,
    json: bool,
    tags: Vec<String>,
    exclude: Vec<String>,
    path: String,
    folder: Option<String>,
    open: bool,
    inbox: bool,
    append: Option<String>,
    positional: Vec<String>,
}

fn parse(args: &[String]) -> Result<Parsed, CliError> {
    let mut p = Parsed::default();
    let mut it = args.iter();
    let value = |flag: &str, inline: Option<&str>, it: &mut std::slice::Iter<String>| {
        inline
            .map(str::to_string)
            .or_else(|| it.next().cloned())
            .ok_or_else(|| CliError::Usage(format!("{flag} needs a value")))
    };
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v)),
            _ => (arg.as_str(), None),
        };
        match flag {
            "--json" => p.json = true,
            "--open" => p.open = true,
            "--inbox" => p.inbox = true,
            "--append" => p.append = Some(value(flag, inline, &mut it)?),
            "--folder" => p.folder = Some(value(flag, inline, &mut it)?),
            "--vault" => p.vault = Some(value(flag, inline, &mut it)?),
            "--tag" => p.tags.push(value(flag, inline, &mut it)?),
            "--exclude" => p.exclude.push(value(flag, inline, &mut it)?),
            "--path" => p.path = value(flag, inline, &mut it)?,
            _ if flag.starts_with("--") => {
                return Err(CliError::Usage(format!("unknown option {flag}")))
            }
            _ => p.positional.push(arg.clone()),
        }
    }
    Ok(p)
}

/// The vault: `--vault`, else the vault containing `cwd`.
pub(crate) fn vault_root(vault: Option<&str>, cwd: &Path) -> Result<PathBuf, CliError> {
    match vault {
        Some(v) => {
            let dir = dunce::canonicalize(cwd.join(v))
                .map_err(|e| CliError::Failed(format!("{v}: {e}")))?;
            if dir.is_dir() {
                Ok(dir)
            } else {
                Err(CliError::Failed(format!("{v}: not a directory")))
            }
        }
        None => Ok(find_vault_root(
            &dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf()),
        )),
    }
}

/// Runs one subcommand (`args[0]`) and writes its answer to `out`. The index lives below
/// `app_data` and is updated from the vault first.
pub fn execute(
    args: &[String],
    cwd: &Path,
    app_data: &Path,
    out: &mut dyn Write,
) -> Result<(), CliError> {
    execute_with(args, cwd, app_data, &mut std::io::stdin().lock(), out)
}

/// Like `execute`, with the standard input given (`append` reads it when no text is passed).
pub fn execute_with(
    args: &[String],
    cwd: &Path,
    app_data: &Path,
    input: &mut dyn std::io::Read,
    out: &mut dyn Write,
) -> Result<(), CliError> {
    let command = args.first().map(String::as_str).unwrap_or_default();
    let p = parse(&args[1..])?;
    if matches!(command, "new" | "append") {
        let root = vault_root(p.vault.as_deref(), cwd)?;
        let request = crate::cli_write::Request {
            positional: &p.positional,
            folder: p.folder.as_deref(),
            open: p.open,
            inbox: p.inbox,
        };
        return crate::cli_write::run(command, &request, &root, app_data, input, out);
    }
    if command == "daily" {
        if !p.positional.is_empty() {
            return Err(CliError::Usage("`daily` takes no arguments".into()));
        }
        let root = vault_root(p.vault.as_deref(), cwd)?;
        return crate::daily::run(
            &root,
            p.append.as_deref(),
            chrono::Local::now().fixed_offset(),
            out,
        );
    }
    if command == "check" {
        if !p.positional.is_empty() {
            return Err(CliError::Usage("`check` takes no arguments".into()));
        }
        return check(&p, cwd, app_data, out);
    }
    let needs_note = matches!(command, "backlinks" | "links" | "props");
    let needs_text = command == "search";
    let expected = usize::from(needs_note);
    if (needs_text && p.positional.is_empty()) || (!needs_text && p.positional.len() != expected) {
        return Err(CliError::Usage(format!(
            "wrong number of arguments for `{command}`"
        )));
    }
    let root = vault_root(p.vault.as_deref(), cwd)?;
    let mut conn = index::open(&index::index_path(app_data, &root))?;
    scan(&mut conn, &root, |_| {})?;

    match command {
        "search" => {
            let mut hits = search::search(&conn, &p.positional.join(" "))?;
            for snippet in hits.iter_mut().flat_map(|h| h.snippets.iter_mut()) {
                snippet.text.retain(|c| c != '\u{1}' && c != '\u{2}');
            }
            emit(out, p.json, &hits, |h| {
                let mut s = format!("{}  {}\n", h.path, h.title);
                for sn in &h.snippets {
                    s.push_str(&format!("  {}: {}\n", sn.line, sn.text));
                }
                s
            })
        }
        "backlinks" => {
            let path = note_path(&conn, &p.positional[0])?;
            let rows = read::backlinks(&conn, &path)?;
            emit(out, p.json, &rows, |b| {
                format!("{}:{}  {}\n", b.source, b.line, b.context)
            })
        }
        "links" => {
            let record = note_record(&conn, &p.positional[0])?;
            emit(out, p.json, &record.links, |l| {
                let target = match &l.resolved {
                    Some(r) => r.clone(),
                    None => "(unresolved)".to_string(),
                };
                format!("{:<8} {} -> {}\n", l.kind, l.target, target)
            })
        }
        "tags" => emit(out, p.json, &read::tags(&conn)?, |t| {
            format!("{:>5}  #{}\n", t.count, t.tag)
        }),
        "notes" => emit(
            out,
            p.json,
            &read::notes_filtered(&conn, &p.tags, &p.path)?,
            |n| format!("{}  {}\n", n.path, n.title),
        ),
        _ => {
            let record = note_record(&conn, &p.positional[0])?;
            emit(out, p.json, &record.properties, |pr| {
                format!("{} ({}): {}\n", pr.key, pr.kind, display_value(&pr.value))
            })
        }
    }
}

/// `nixe check`: prints the health report; fails (exit 1) when a link is broken.
fn check(p: &Parsed, cwd: &Path, app_data: &Path, out: &mut dyn Write) -> Result<(), CliError> {
    let root = vault_root(p.vault.as_deref(), cwd)?;
    let mut conn = index::open(&index::index_path(app_data, &root))?;
    scan(&mut conn, &root, |_| {})?;
    let report = index::health::report(&conn, &p.exclude)?;
    let text = if p.json {
        let mut s =
            serde_json::to_string_pretty(&report).map_err(|e| CliError::Failed(e.to_string()))?;
        s.push('\n');
        s
    } else {
        health_text(&report)
    };
    out.write_all(text.as_bytes())
        .map_err(|e| CliError::Failed(e.to_string()))?;
    match report.broken_links.len() {
        0 => Ok(()),
        n => Err(CliError::Failed(format!("{n} broken link(s)"))),
    }
}

fn health_text(r: &index::health::HealthReport) -> String {
    let mut s = format!("Broken links ({})\n", r.broken_links.len());
    for l in &r.broken_links {
        s.push_str(&format!("  {}:{}  {}\n", l.source, l.line, l.context));
    }
    s.push_str(&format!("Orphan notes ({})\n", r.orphans.len()));
    for n in &r.orphans {
        s.push_str(&format!("  {}\n", n.path));
    }
    s.push_str(&format!("Duplicate basenames ({})\n", r.duplicates.len()));
    for d in &r.duplicates {
        s.push_str(&format!("  {}: {}\n", d.name, d.paths.join(", ")));
    }
    s.push_str(&format!(
        "Unused attachments ({})\n",
        r.unused_attachments.len()
    ));
    for a in &r.unused_attachments {
        s.push_str(&format!("  {a}\n"));
    }
    s
}

fn display_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Writes `rows` as pretty JSON, or as text with `line` per row.
fn emit<T: Serialize>(
    out: &mut dyn Write,
    json: bool,
    rows: &[T],
    line: impl Fn(&T) -> String,
) -> Result<(), CliError> {
    let text = if json {
        let mut s =
            serde_json::to_string_pretty(rows).map_err(|e| CliError::Failed(e.to_string()))?;
        s.push('\n');
        s
    } else {
        rows.iter().map(line).collect()
    };
    out.write_all(text.as_bytes())
        .map_err(|e| CliError::Failed(e.to_string()))
}

/// The indexed path for `name`: a vault-relative path, with or without `.md`, or a unique
/// note name (the same rules as a wikilink).
pub(crate) fn note_path(conn: &rusqlite::Connection, name: &str) -> Result<String, CliError> {
    let paths: Vec<String> = read::notes(conn)?.into_iter().map(|n| n.path).collect();
    resolve_link(name.trim_start_matches("./"), &paths)
        .ok_or_else(|| CliError::Failed(format!("{name}: no such note, or the name is ambiguous")))
}

fn note_record(conn: &rusqlite::Connection, name: &str) -> Result<read::NoteRecord, CliError> {
    let path = note_path(conn, name)?;
    read::note_meta(conn, &path)?.ok_or_else(|| CliError::Failed(format!("{name}: not indexed")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_a_leading_subcommand_name_skips_the_viewer() {
        assert!(is_subcommand(&args(&["search", "x"])));
        assert!(is_subcommand(&args(&["tags"])));
        assert!(!is_subcommand(&args(&[])));
        assert!(!is_subcommand(&args(&["-"])));
        assert!(!is_subcommand(&args(&["notes.md"])));
        assert!(!is_subcommand(&args(&["./search"])));
        assert!(!is_subcommand(&args(&["--vault", "x", "search"])));
    }

    #[test]
    fn options_accept_an_equals_sign() {
        let p = parse(&args(&[
            "--vault=v",
            "--tag=a",
            "--tag",
            "b",
            "q",
            "--json",
        ]))
        .unwrap();
        assert_eq!(p.vault.as_deref(), Some("v"));
        assert_eq!(p.tags, ["a", "b"]);
        assert_eq!(p.positional, ["q"]);
        assert!(p.json);
        assert!(parse(&args(&["--vault"])).is_err());
    }
}
