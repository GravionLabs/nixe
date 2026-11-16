//! `nixe mcp`: a read-only MCP server over stdio. Agents ask the vault index instead of
//! scanning files. Tools: `search`, `backlinks`, `outgoing_links`, `tags`, `notes_by_property`,
//! `read_note` and `resolve_link`. Nothing writes; paths in and out are vault-relative, and a
//! path outside the vault is refused. Protocol handling is the SDK's (`rmcp`).

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use rmcp::handler::server::wrapper::Parameters;
use rmcp::{schemars, tool, tool_router, ServiceExt};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::cli::{note_path, vault_root, CliError};
use crate::index::{self, read, scan, search};
use crate::vault::resolve::resolve_link;

/// Runs the server on stdin/stdout until the client closes it. `args` are those after `mcp`:
/// only `--vault <dir>`.
pub fn run(args: &[String], cwd: &Path, app_data: &Path) -> Result<(), CliError> {
    let mut vault = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (arg.as_str(), None),
        };
        match flag {
            "--vault" => {
                vault = Some(
                    inline
                        .or_else(|| it.next().cloned())
                        .ok_or_else(|| CliError::Usage("--vault needs a value".into()))?,
                )
            }
            _ => return Err(CliError::Usage(format!("unexpected argument {arg}"))),
        }
    }
    let root = vault_root(vault.as_deref(), cwd)?;
    let server = open(&root, app_data)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| CliError::Failed(e.to_string()))?;
    runtime.block_on(async {
        let service = server
            .serve(rmcp::transport::stdio())
            .await
            .map_err(|e| CliError::Failed(e.to_string()))?;
        service
            .waiting()
            .await
            .map_err(|e| CliError::Failed(e.to_string()))?;
        Ok(())
    })
}

/// The server for the vault at `root`, with its index below `app_data` (the app's own).
pub fn open(root: &Path, app_data: &Path) -> Result<VaultServer, CliError> {
    let conn = index::open(&index::index_path(app_data, root))?;
    Ok(VaultServer::new(root.to_path_buf(), conn))
}

#[derive(Clone)]
pub struct VaultServer {
    root: PathBuf,
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SearchArgs {
    /// Search text. Words match as prefixes; `"a phrase"`, `tag:#name` and `path:folder/` work.
    query: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct NoteArgs {
    /// Vault-relative path (with or without `.md`) or a unique note name.
    note: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct PropertyArgs {
    /// The frontmatter property name (case-insensitive).
    key: String,
    /// Only notes whose value equals this (a list property: contains it).
    value: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ResolveArgs {
    /// A wikilink target such as `Note`, `folder/Deep` or `Note.md`.
    target: String,
}

#[derive(Serialize)]
struct Resolved {
    path: Option<String>,
}

#[derive(Serialize)]
struct NoteContent {
    path: String,
    content: String,
}

impl VaultServer {
    pub fn new(root: PathBuf, conn: Connection) -> Self {
        Self {
            root,
            conn: Arc::new(Mutex::new(conn)),
        }
    }

    /// Brings the index up to date with the files on disk, then runs `f` on it.
    fn with_index<T: Serialize>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<String, String> {
        let mut conn = self.conn.lock().map_err(|_| "index is unavailable")?;
        scan(&mut conn, &self.root, |_| {}).map_err(|e| format!("index: {e}"))?;
        let value = f(&conn)?;
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
    }

    fn note(conn: &Connection, name: &str) -> Result<String, String> {
        refuse_outside(name)?;
        note_path(conn, name).map_err(|e| match e {
            CliError::Usage(m) | CliError::Failed(m) => m,
        })
    }
}

/// Refuses absolute paths and `..`: a path argument names a place inside the vault.
fn refuse_outside(name: &str) -> Result<(), String> {
    let path = Path::new(name);
    let escapes = path.is_absolute()
        || name.starts_with(['/', '\\'])
        || name.contains(':') && name.as_bytes().get(1) == Some(&b':')
        || path.components().any(|c| matches!(c, Component::ParentDir))
        || name.split(['/', '\\']).any(|part| part == "..");
    if escapes {
        Err(format!("{name}: the path is outside the vault"))
    } else {
        Ok(())
    }
}

fn db<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| format!("index: {e}"))
}

#[tool_router(server_handler)]
impl VaultServer {
    #[tool(
        description = "Full-text search of the vault. Returns notes with matching lines, best first.",
        annotations(read_only_hint = true)
    )]
    fn search(&self, Parameters(a): Parameters<SearchArgs>) -> Result<String, String> {
        self.with_index(|c| {
            let mut hits = db(search::search(c, &a.query))?;
            for s in hits.iter_mut().flat_map(|h| h.snippets.iter_mut()) {
                s.text.retain(|ch| ch != '\u{1}' && ch != '\u{2}');
            }
            Ok(hits)
        })
    }

    #[tool(
        description = "Links that point to a note: source note, line and the linking text.",
        annotations(read_only_hint = true)
    )]
    fn backlinks(&self, Parameters(a): Parameters<NoteArgs>) -> Result<String, String> {
        self.with_index(|c| db(read::backlinks(c, &Self::note(c, &a.note)?)))
    }

    #[tool(
        description = "Links, embeds and Markdown links inside a note, with their resolved target path.",
        annotations(read_only_hint = true)
    )]
    fn outgoing_links(&self, Parameters(a): Parameters<NoteArgs>) -> Result<String, String> {
        self.with_index(|c| {
            let path = Self::note(c, &a.note)?;
            let record =
                db(read::note_meta(c, &path))?.ok_or(format!("{}: not indexed", a.note))?;
            Ok(record.links)
        })
    }

    #[tool(
        description = "Every tag with the number of notes using it, most used first.",
        annotations(read_only_hint = true)
    )]
    fn tags(&self) -> Result<String, String> {
        self.with_index(|c| db(read::tags(c)))
    }

    #[tool(
        description = "Notes that have a frontmatter property, optionally with a given value, with the typed value.",
        annotations(read_only_hint = true)
    )]
    fn notes_by_property(&self, Parameters(a): Parameters<PropertyArgs>) -> Result<String, String> {
        self.with_index(|c| db(read::notes_by_property(c, &a.key, a.value.as_deref())))
    }

    #[tool(
        description = "The Markdown text of a note, by vault-relative path or unique note name.",
        annotations(read_only_hint = true)
    )]
    fn read_note(&self, Parameters(a): Parameters<NoteArgs>) -> Result<String, String> {
        self.with_index(|c| {
            let path = Self::note(c, &a.note)?;
            let file =
                dunce::canonicalize(self.root.join(&path)).map_err(|e| format!("{path}: {e}"))?;
            // A symlink inside the vault must not lead out of it.
            if !file.starts_with(&self.root) {
                return Err(format!("{path}: the path is outside the vault"));
            }
            let content = std::fs::read_to_string(&file).map_err(|e| format!("{path}: {e}"))?;
            Ok(NoteContent { path, content })
        })
    }

    #[tool(
        description = "Resolves a wikilink target to the vault-relative path of the note it names, or null.",
        annotations(read_only_hint = true)
    )]
    fn resolve_link(&self, Parameters(a): Parameters<ResolveArgs>) -> Result<String, String> {
        refuse_outside(&a.target)?;
        self.with_index(|c| {
            let paths: Vec<String> = db(read::notes(c))?.into_iter().map(|n| n.path).collect();
            let target = a.target.trim_start_matches("./");
            Ok(Resolved {
                path: resolve_link(target, &paths),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_leaving_the_vault_are_refused() {
        for bad in [
            "../x.md",
            "a/../../x",
            "/etc/passwd",
            "\\win",
            "C:\\x",
            "..",
        ] {
            assert!(refuse_outside(bad).is_err(), "{bad}");
        }
        for good in ["Note", "folder/Deep.md", "./Note.md", "a..b.md"] {
            assert!(refuse_outside(good).is_ok(), "{good}");
        }
    }
}
