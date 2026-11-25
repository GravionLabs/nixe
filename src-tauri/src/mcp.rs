//! `nixe mcp`: a read-only MCP server over stdio. Agents ask the vault index instead of
//! scanning files. Tools: `search`, `backlinks`, `outgoing_links`, `tags`, `notes_by_property`,
//! `read_note` and `resolve_link`. Nothing writes, except `clip_link` (#508) that only exists
//! with `--allow-clip` and only creates new notes in the links folder; paths in and out are
//! vault-relative, and a path outside the vault is refused. Protocol handling is the SDK's
//! (`rmcp`).

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::{schemars, tool, tool_handler, tool_router, ServiceExt};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::cli::{note_path, select_roots, CliError};
use crate::index::{self, read, scan, search};
use crate::vault::resolve::resolve_link;
use crate::workspace::WorkspaceRoot;

/// Runs the server on stdin/stdout until the client closes it. `args` are those after `mcp`:
/// `--vault <dir>` (several times), or `--workspace <name>` for a saved workspace, and
/// `--allow-clip` to offer the write tool `clip_link`.
pub fn run(args: &[String], cwd: &Path, app_data: &Path) -> Result<(), CliError> {
    let mut vaults = Vec::new();
    let mut workspace = None;
    let mut allow_clip = false;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (arg.as_str(), None),
        };
        match flag {
            "--allow-clip" if inline.is_none() => allow_clip = true,
            "--vault" | "--workspace" => {
                let value = inline
                    .or_else(|| it.next().cloned())
                    .ok_or_else(|| CliError::Usage(format!("{flag} needs a value")))?;
                if flag == "--vault" {
                    vaults.push(value);
                } else {
                    workspace = Some(value);
                }
            }
            _ => return Err(CliError::Usage(format!("unexpected argument {arg}"))),
        }
    }
    let roots = select_roots(&vaults, workspace.as_deref(), cwd, app_data)?;
    let server = open_roots(&roots, app_data)?.allow_clip(allow_clip)?;
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
    open_roots(
        &crate::workspace::name_roots(&[root.to_path_buf()]),
        app_data,
    )
}

/// The server for several roots (#117): `search`, `tags` and `notes_by_property` cover all of
/// them, the tools that name a note take a `root` argument when there is more than one.
pub fn open_roots(roots: &[WorkspaceRoot], app_data: &Path) -> Result<VaultServer, CliError> {
    let mut list = Vec::new();
    for r in roots {
        let conn = index::open(&index::index_path(app_data, Path::new(&r.path)))?;
        list.push(Arc::new(McpRoot {
            name: r.name.clone(),
            path: PathBuf::from(&r.path),
            conn: Mutex::new(conn),
        }));
    }
    Ok(VaultServer {
        roots: list,
        app_data: app_data.to_path_buf(),
        tool_router: VaultServer::read_router(),
    })
}

struct McpRoot {
    name: String,
    path: PathBuf,
    conn: Mutex<Connection>,
}

#[derive(Clone)]
pub struct VaultServer {
    roots: Vec<Arc<McpRoot>>,
    app_data: PathBuf,
    tool_router: ToolRouter<VaultServer>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SearchArgs {
    /// Search text. Words match as prefixes; `"a phrase"`, `tag:#name` and `path:folder/` work.
    query: String,
    /// Only the roots with these names; default: all. `root:name` in the query works too.
    roots: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct NoteArgs {
    /// Vault-relative path (with or without `.md`) or a unique note name.
    note: String,
    /// Name of the root, when the server covers several (`roots` lists them).
    root: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct TagsArgs {
    /// Only this root; default: all roots, counts added up.
    root: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct PropertyArgs {
    /// The frontmatter property name (case-insensitive).
    key: String,
    /// Only notes whose value equals this (a list property: contains it).
    value: Option<String>,
    /// Name of the root; default: all roots.
    root: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ResolveArgs {
    /// A wikilink target such as `Note`, `folder/Deep` or `Note.md`.
    target: String,
    /// Name of the root, when the server covers several.
    root: Option<String>,
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
    /// Adds the write tool `clip_link` when `allow` is set (`--allow-clip`); without it the
    /// server stays read-only and the tool does not exist.
    pub fn allow_clip(mut self, allow: bool) -> Result<Self, CliError> {
        if allow {
            #[cfg(desktop)]
            self.tool_router.merge(VaultServer::clip_router());
            #[cfg(not(desktop))]
            return Err(CliError::Usage(
                "--allow-clip is not available on this platform".into(),
            ));
        }
        Ok(self)
    }

    /// The root a tool works on: the named one, else the only one.
    fn pick(&self, name: Option<&str>) -> Result<&Arc<McpRoot>, String> {
        match (name, self.roots.as_slice()) {
            (Some(n), roots) => roots
                .iter()
                .find(|r| r.name.eq_ignore_ascii_case(n))
                .ok_or_else(|| format!("{n}: no such root ({})", self.names())),
            (None, [only]) => Ok(only),
            (None, _) => Err(format!("name the root: {}", self.names())),
        }
    }

    fn names(&self) -> String {
        self.roots
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// Brings the index of `root` up to date with the files on disk, then runs `f` on it.
    fn with_root<T: Serialize>(
        root: &McpRoot,
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<String, String> {
        let mut conn = root.conn.lock().map_err(|_| "index is unavailable")?;
        scan(&mut conn, &root.path, |_| {}).map_err(|e| format!("index: {e}"))?;
        let value = f(&conn)?;
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
    }

    /// Like `with_root` for the root named by `name` (or the only one).
    fn with_index<T: Serialize>(
        &self,
        name: Option<&str>,
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<String, String> {
        Self::with_root(self.pick(name)?, f)
    }

    fn note(conn: &Connection, name: &str) -> Result<String, String> {
        refuse_outside(name)?;
        note_path(conn, name).map_err(|e| match e {
            CliError::Usage(m) | CliError::Failed(m) => m,
        })
    }
}

/// Refuses absolute paths and `..`: a path argument names a place inside the vault.
pub(crate) fn refuse_outside(name: &str) -> Result<(), String> {
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

#[tool_router(router = read_router)]
impl VaultServer {
    #[tool(
        description = "Full-text search of the vault. Returns notes with matching lines, best first.",
        annotations(read_only_hint = true)
    )]
    fn search(&self, Parameters(a): Parameters<SearchArgs>) -> Result<String, String> {
        let mut guards = Vec::new();
        for r in &self.roots {
            let mut conn = r.conn.lock().map_err(|_| "index is unavailable")?;
            scan(&mut conn, &r.path, |_| {}).map_err(|e| format!("index: {e}"))?;
            guards.push(conn);
        }
        let paths: Vec<String> = self
            .roots
            .iter()
            .map(|r| r.path.to_string_lossy().into_owned())
            .collect();
        let list: Vec<search::SearchRoot> = self
            .roots
            .iter()
            .zip(&guards)
            .zip(&paths)
            .filter(|((r, _), _)| {
                a.roots
                    .as_ref()
                    .is_none_or(|names| names.iter().any(|n| n.eq_ignore_ascii_case(&r.name)))
            })
            .map(|((r, conn), path)| search::SearchRoot {
                name: &r.name,
                path,
                conn,
            })
            .collect();
        let mut hits = db(search::search_roots(&list, &a.query))?;
        for s in hits.iter_mut().flat_map(|h| h.snippets.iter_mut()) {
            s.text.retain(|ch| ch != '\u{1}' && ch != '\u{2}');
        }
        if self.roots.len() == 1 {
            // One vault: the answer keeps its old shape.
            for h in &mut hits {
                h.root = None;
                h.root_path = None;
            }
        }
        serde_json::to_string_pretty(&hits).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Links that point to a note: source note, line and the linking text.",
        annotations(read_only_hint = true)
    )]
    fn backlinks(&self, Parameters(a): Parameters<NoteArgs>) -> Result<String, String> {
        self.with_index(a.root.as_deref(), |c| {
            db(read::backlinks(c, &Self::note(c, &a.note)?))
        })
    }

    #[tool(
        description = "Links, embeds and Markdown links inside a note, with their resolved target path.",
        annotations(read_only_hint = true)
    )]
    fn outgoing_links(&self, Parameters(a): Parameters<NoteArgs>) -> Result<String, String> {
        self.with_index(a.root.as_deref(), |c| {
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
    fn tags(&self, Parameters(a): Parameters<TagsArgs>) -> Result<String, String> {
        let roots = match a.root.as_deref() {
            Some(n) => vec![self.pick(Some(n))?],
            None => self.roots.iter().collect(),
        };
        let mut sums: std::collections::BTreeMap<String, usize> = Default::default();
        for r in roots {
            let mut conn = r.conn.lock().map_err(|_| "index is unavailable")?;
            scan(&mut conn, &r.path, |_| {}).map_err(|e| format!("index: {e}"))?;
            for t in db(read::tags(&conn))? {
                *sums.entry(t.tag).or_default() += t.count;
            }
        }
        let mut tags: Vec<read::TagCount> = sums
            .into_iter()
            .map(|(tag, count)| read::TagCount { tag, count })
            .collect();
        tags.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
        serde_json::to_string_pretty(&tags).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Notes that have a frontmatter property, optionally with a given value, with the typed value.",
        annotations(read_only_hint = true)
    )]
    fn notes_by_property(&self, Parameters(a): Parameters<PropertyArgs>) -> Result<String, String> {
        if a.root.is_none() && self.roots.len() > 1 {
            let mut rows = Vec::new();
            for r in &self.roots {
                let found = Self::with_root(r, |c| {
                    db(read::notes_by_property(c, &a.key, a.value.as_deref()))
                })?;
                let items: Vec<serde_json::Value> =
                    serde_json::from_str(&found).map_err(|e| e.to_string())?;
                for mut item in items {
                    if let Some(o) = item.as_object_mut() {
                        o.insert("root".into(), r.name.clone().into());
                    }
                    rows.push(item);
                }
            }
            return serde_json::to_string_pretty(&rows).map_err(|e| e.to_string());
        }
        self.with_index(a.root.as_deref(), |c| {
            db(read::notes_by_property(c, &a.key, a.value.as_deref()))
        })
    }

    #[tool(
        description = "The Markdown text of a note, by vault-relative path or unique note name.",
        annotations(read_only_hint = true)
    )]
    fn read_note(&self, Parameters(a): Parameters<NoteArgs>) -> Result<String, String> {
        let root = self.pick(a.root.as_deref())?;
        Self::with_root(root, |c| {
            let path = Self::note(c, &a.note)?;
            let file =
                dunce::canonicalize(root.path.join(&path)).map_err(|e| format!("{path}: {e}"))?;
            // A symlink inside the vault must not lead out of it.
            if !file.starts_with(&root.path) {
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
        self.with_index(a.root.as_deref(), |c| {
            let paths: Vec<String> = db(read::notes(c))?.into_iter().map(|n| n.path).collect();
            let target = a.target.trim_start_matches("./");
            Ok(Resolved {
                path: resolve_link(target, &paths),
            })
        })
    }
}

#[tool_handler(router = self.tool_router.clone())]
impl rmcp::ServerHandler for VaultServer {}

#[cfg(desktop)]
#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ClipArgs {
    /// The page to save: an `http` or `https` address.
    url: String,
    /// Title of the note; default: the title of the page.
    title: Option<String>,
    /// Tags of the note.
    tags: Option<Vec<String>>,
    /// Vault-relative folder; only the links folder or a folder below it. Default: the links folder.
    folder: Option<String>,
    /// Name of the vault, when the server covers several.
    vault: Option<String>,
}

#[cfg(desktop)]
#[derive(Serialize)]
struct Clipped {
    path: String,
    created: bool,
}

/// The `folder` of a clip, normalised, when it is the links folder or below it.
#[cfg(desktop)]
pub(crate) fn links_subfolder(folder: &str, links: &str) -> Result<String, String> {
    refuse_outside(folder)?;
    let clean = |s: &str| {
        s.replace('\\', "/")
            .split('/')
            .filter(|p| !p.is_empty() && *p != ".")
            .collect::<Vec<_>>()
            .join("/")
    };
    let (rel, links) = (clean(folder), clean(links));
    if rel == links || rel.starts_with(&format!("{links}/")) {
        Ok(rel)
    } else {
        Err(format!("{folder}: outside the links folder ({links})"))
    }
}

#[cfg(desktop)]
#[tool_router(router = clip_router)]
impl VaultServer {
    #[tool(
        description = "Saves a web page as a link note in the links folder and returns {path, created}. A URL that a link note holds already returns that note (created: false); an existing note is never changed.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    fn clip_link(&self, Parameters(a): Parameters<ClipArgs>) -> Result<String, String> {
        use crate::links::{self, ClipRequest, DEFAULT_FOLDER};
        let root = self.pick(a.vault.as_deref())?;
        let canonical = dunce::canonicalize(&root.path).map_err(|e| e.to_string())?;
        let links_folder = crate::vault::config::Config::load(&canonical)
            .links_folder()
            .unwrap_or_else(|| DEFAULT_FOLDER.to_string());
        let folder = match a.folder.as_deref() {
            Some(f) => Some(links_subfolder(f, &links_folder)?),
            None => None,
        };
        let result = links::clip(
            &canonical,
            &self.app_data,
            ClipRequest {
                url: a.url,
                html: None,
                title: a.title,
                tags: a.tags.unwrap_or_default(),
                folder,
                ..ClipRequest::default()
            },
        )
        .map_err(|e| e.to_string())?;
        let path = result
            .path
            .strip_prefix(&canonical)
            .map_err(|_| "the note is outside the vault".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        // The next search sees the note.
        {
            let mut conn = root.conn.lock().map_err(|_| "index is unavailable")?;
            scan(&mut conn, &root.path, |_| {}).map_err(|e| format!("index: {e}"))?;
        }
        serde_json::to_string_pretty(&Clipped {
            path,
            created: result.created,
        })
        .map_err(|e| e.to_string())
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

    #[cfg(desktop)]
    #[test]
    fn a_clip_folder_stays_in_the_links_folder() {
        assert_eq!(links_subfolder("Links", "Links").unwrap(), "Links");
        assert_eq!(links_subfolder("./Links/a/", "Links").unwrap(), "Links/a");
        assert_eq!(links_subfolder("Links\\a", "Links").unwrap(), "Links/a");
        for bad in [
            "Notes",
            "Links2",
            "Link",
            "",
            "Links/../Notes",
            "/Links",
            ".",
        ] {
            assert!(links_subfolder(bad, "Links").is_err(), "{bad}");
        }
    }
}
