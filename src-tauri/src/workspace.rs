//! Workspaces (#116): several folders ("roots") in one window. A workspace is a named list of
//! roots, saved in the app data directory (`workspaces/<name>.json`); nothing is written into the
//! folders. Each root keeps its own kind, its own file list (so its own link resolution) and its
//! own index (`index::index_path` is per root path).
//!
//! A wikilink resolves inside the root of the note that holds it. A link to a note of another root
//! names that root with a prefix: `[[Root name:Note]]`, `[[Root name:folder/Note#Heading]]`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::vault::resolve::Resolver;
use crate::vault::{self, find_vault_root};

/// Folder of the saved workspaces inside the app data directory.
const DIR: &str = "workspaces";
/// Upper bound for a workspace file.
const MAX_BYTES: u64 = 1024 * 1024;

/// What a root is; it decides how the root's notes are read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RootKind {
    /// Has an `.obsidian/` folder.
    Obsidian,
    /// An Azure DevOps wiki: a `.order` file or an `.attachments/` folder at the top.
    Wiki,
    /// Any other folder of Markdown files.
    Folder,
}

/// One folder of a workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceRoot {
    /// Absolute path on this device, forward slashes. For a root with a `template` the resolved
    /// path; the rest of the core only reads this. A root whose variable is unresolved keeps the
    /// template here, which is no existing folder.
    pub path: String,
    /// The path as written (`$Documents/Books`, `$$Archive/notes`) when it starts with `$`; saved
    /// instead of the resolved path so the file holds no device-specific path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// The name that a link prefix uses; unique in the workspace.
    pub name: String,
    pub kind: RootKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workspace {
    pub name: String,
    pub roots: Vec<WorkspaceRoot>,
}

/// The kind of the folder at `path`.
pub fn detect_kind(path: &Path) -> RootKind {
    if path.join(".obsidian").is_dir() {
        RootKind::Obsidian
    } else if path.join(".order").is_file() || path.join(".attachments").is_dir() {
        RootKind::Wiki
    } else {
        RootKind::Folder
    }
}

fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The folders the built-in location variables stand for on this device.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Locations {
    pub home: Option<PathBuf>,
    pub documents: Option<PathBuf>,
}

impl Locations {
    /// Without a running app (command line, MCP): the home folder from the environment, the
    /// documents folder below it.
    pub fn from_env() -> Locations {
        let home = ["HOME", "USERPROFILE"]
            .iter()
            .filter_map(std::env::var_os)
            .find(|v| !v.is_empty())
            .map(PathBuf::from);
        Locations {
            documents: home.as_ref().map(|h| h.join("Documents")),
            home,
        }
    }

    /// From the Tauri path API.
    pub fn from_app<R: tauri::Runtime>(app: &impl tauri::Manager<R>) -> Locations {
        let paths = app.path();
        Locations {
            home: paths.home_dir().ok(),
            documents: paths.document_dir().ok(),
        }
    }

    fn get(&self, name: &str) -> Option<&Path> {
        match name {
            "Home" => self.home.as_deref(),
            "Documents" => self.documents.as_deref(),
            _ => None,
        }
    }

    /// Resolves a path written with a leading `$Name`: `$Home/x` becomes the home folder of this
    /// device plus `x`; `$$name` is the literal `$name`. A `$` anywhere else, or a `$` that no
    /// name follows, is literal. A path that does not start with `$` is returned as it is. The
    /// error names the variable that has no value here.
    pub fn resolve(&self, template: &str) -> Result<String, String> {
        let Some(rest) = template.strip_prefix('$') else {
            return Ok(template.to_string());
        };
        if rest.starts_with('$') {
            return Ok(rest.to_string());
        }
        let end = rest.find(['/', '\\']).unwrap_or(rest.len());
        let (name, tail) = rest.split_at(end);
        if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Ok(template.to_string());
        }
        let base = self.get(name).ok_or_else(|| name.to_string())?;
        let tail = tail.trim_start_matches(['/', '\\']);
        Ok(if tail.is_empty() {
            slashes(base)
        } else {
            slashes(&base.join(tail))
        })
    }
}

/// A root as it is stored in the file: the template, else the path.
#[derive(Serialize, Deserialize)]
struct StoredRoot {
    path: String,
    name: String,
    kind: RootKind,
}

#[derive(Serialize, Deserialize)]
struct StoredWorkspace {
    name: String,
    roots: Vec<StoredRoot>,
}

impl StoredRoot {
    fn of(root: &WorkspaceRoot) -> StoredRoot {
        StoredRoot {
            path: root.template.clone().unwrap_or_else(|| root.path.clone()),
            name: root.name.clone(),
            kind: root.kind,
        }
    }

    fn resolve(self, locations: &Locations) -> WorkspaceRoot {
        if !self.path.starts_with('$') {
            return WorkspaceRoot {
                path: self.path,
                template: None,
                name: self.name,
                kind: self.kind,
            };
        }
        WorkspaceRoot {
            // An unresolved variable keeps the template as path: no folder, so it is skipped.
            path: locations
                .resolve(&self.path)
                .unwrap_or_else(|_| self.path.clone()),
            template: Some(self.path),
            name: self.name,
            kind: self.kind,
        }
    }
}

impl Workspace {
    pub fn new(name: &str) -> Result<Workspace, String> {
        Ok(Workspace {
            name: valid_name(name)?,
            roots: Vec::new(),
        })
    }

    /// Adds the folder at `path` (an Obsidian vault is added as its vault root). A folder that is
    /// already a root is not added twice. Returns the new or the existing root.
    ///
    /// A path that starts with `$` (`$Documents/Books`) is a template: it is resolved for this
    /// device and kept next to the resolved path, unless the folder is inside a vault and the
    /// vault root is added instead.
    pub fn add_root(
        &mut self,
        path: &Path,
        locations: &Locations,
    ) -> Result<WorkspaceRoot, String> {
        let written = slashes(path);
        let template = written.starts_with('$').then_some(written);
        let path = match &template {
            Some(t) => PathBuf::from(
                locations
                    .resolve(t)
                    .map_err(|v| format!("{t}: the variable ${v} has no value on this device"))?,
            ),
            None => path.to_path_buf(),
        };
        let path = path.as_path();
        if !path.is_dir() {
            return Err(format!("{}: not a folder", path.display()));
        }
        let root = dunce::canonicalize(find_vault_root(path))
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let template = template.filter(|_| dunce::canonicalize(path).is_ok_and(|p| p == root));
        let key = slashes(&root);
        if let Some(existing) = self.roots.iter().find(|r| r.path == key) {
            return Ok(existing.clone());
        }
        let base = root
            .file_name()
            .map_or_else(|| key.clone(), |n| n.to_string_lossy().into_owned());
        let entry = WorkspaceRoot {
            name: self.free_name(&base),
            kind: detect_kind(&root),
            path: key,
            template,
        };
        self.roots.push(entry.clone());
        Ok(entry)
    }

    /// Removes the root at `path`; false when there is none.
    pub fn remove_root(&mut self, path: &str) -> bool {
        let before = self.roots.len();
        self.roots.retain(|r| r.path != path);
        self.roots.len() != before
    }

    /// `base`, or `base (2)`, `base (3)` … when a root has the name already.
    fn free_name(&self, base: &str) -> String {
        let taken = |n: &str| self.roots.iter().any(|r| r.name.eq_ignore_ascii_case(n));
        if !taken(base) {
            return base.to_string();
        }
        (2..)
            .map(|i| format!("{base} ({i})"))
            .find(|n| !taken(n))
            .expect("an unbounded range")
    }
}

/// The roots of a command line (`--vault` given several times): each folder named by its folder
/// name, made unique like in a window (`notes`, `notes (2)`); the same folder twice counts once.
pub fn name_roots(paths: &[PathBuf]) -> Vec<WorkspaceRoot> {
    let mut ws = Workspace {
        name: String::new(),
        roots: Vec::new(),
    };
    for path in paths {
        let key = slashes(path);
        if ws.roots.iter().any(|r| r.path == key) {
            continue;
        }
        let base = path
            .file_name()
            .map_or_else(|| key.clone(), |n| n.to_string_lossy().into_owned());
        let root = WorkspaceRoot {
            name: ws.free_name(&base),
            kind: detect_kind(path),
            path: key,
            template: None,
        };
        ws.roots.push(root);
    }
    ws.roots
}

/// A workspace name that is a safe file name: no separators, no leading dot, not empty.
fn valid_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let bad = name.is_empty()
        || name.starts_with('.')
        || name.len() > 100
        || name.ends_with('.')
        || is_reserved(name)
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c));
    if bad {
        Err(format!("\"{name}\" is not a valid workspace name"))
    } else {
        Ok(name.to_string())
    }
}

/// Names that Windows keeps for devices (`CON`, `NUL`, `COM1` …), with or without an extension.
fn is_reserved(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.ends_with(|c: char| c.is_ascii_digit() && c != '0'))
}

fn file_of(dir: &Path, name: &str) -> Result<PathBuf, String> {
    Ok(dir.join(DIR).join(format!("{}.json", valid_name(name)?)))
}

/// Atomically saves `workspace` below the app data directory `dir`, replacing one of that name.
/// A root with a template is saved with the template, not the resolved path.
pub fn save(dir: &Path, workspace: &Workspace) -> Result<(), String> {
    let target = file_of(dir, &workspace.name)?;
    let folder = target.parent().expect("a file below the folder");
    fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let stored = StoredWorkspace {
        name: workspace.name.clone(),
        roots: workspace.roots.iter().map(StoredRoot::of).collect(),
    };
    let json = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    let tmp = folder.join(format!(".{}.nixe-tmp", workspace.name));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, &target)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", target.display())
    })
}

/// The saved workspace `name`; roots whose folder is gone stay in it (the UI marks them). A root
/// saved with a template (`$Home/x`) gets the path it resolves to on this device; one whose
/// variable has no value here keeps the template as its path, which is no folder.
pub fn load(dir: &Path, name: &str, locations: &Locations) -> Result<Workspace, String> {
    let file = file_of(dir, name)?;
    let len = fs::metadata(&file)
        .map_err(|e| format!("workspace \"{name}\": {e}"))?
        .len();
    if len > MAX_BYTES {
        return Err("workspace file too large".into());
    }
    let text = fs::read_to_string(&file).map_err(|e| format!("workspace \"{name}\": {e}"))?;
    let stored: StoredWorkspace =
        serde_json::from_str(&text).map_err(|e| format!("workspace \"{name}\": {e}"))?;
    Ok(Workspace {
        name: valid_name(name)?,
        roots: stored
            .roots
            .into_iter()
            .map(|r| r.resolve(locations))
            .collect(),
    })
}

/// The names of the saved workspaces, sorted.
pub fn list(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir.join(DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            file.strip_suffix(".json").map(str::to_string)
        })
        .filter(|n| valid_name(n).is_ok())
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names
}

/// Deletes the saved workspace `name` (only its file; no folder is touched).
pub fn delete(dir: &Path, name: &str) -> Result<(), String> {
    let file = file_of(dir, name)?;
    match fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", file.display())),
    }
}

/// A link target resolved to a note of some root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedLink {
    /// Path of the root.
    pub root: String,
    /// Path of the note, relative to that root.
    pub path: String,
}

/// Link resolution over the roots of a workspace: one resolver per root, built from the root's own
/// files.
pub struct WorkspaceLinks {
    roots: Vec<(WorkspaceRoot, Resolver)>,
}

impl WorkspaceLinks {
    pub fn new(workspace: &Workspace) -> Self {
        let roots = workspace
            .roots
            .iter()
            .map(|r| {
                let files = vault::list_vault_files(Path::new(&r.path));
                (r.clone(), Resolver::new(&files))
            })
            .collect();
        WorkspaceLinks { roots }
    }

    /// Resolves `target` of a note in the root `from` (its path). With a prefix that names a root
    /// (`Root name:Note`) the note is looked up in that root, else in `from`. A prefix that names
    /// no root is part of the note name.
    pub fn resolve(&self, from: &str, target: &str) -> Option<ResolvedLink> {
        if let Some((prefix, rest)) = target.split_once(':') {
            let prefix = prefix.trim();
            if let Some((root, resolver)) = self
                .roots
                .iter()
                .find(|(r, _)| r.name.eq_ignore_ascii_case(prefix))
            {
                return resolver.resolve(rest.trim()).map(|path| ResolvedLink {
                    root: root.path.clone(),
                    path,
                });
            }
        }
        let (root, resolver) = self.roots.iter().find(|(r, _)| r.path == from)?;
        resolver.resolve(target).map(|path| ResolvedLink {
            root: root.path.clone(),
            path,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Locations = Locations {
        home: None,
        documents: None,
    };

    fn device(base: &Path) -> Locations {
        Locations {
            home: Some(base.join("home")),
            documents: Some(base.join("home/Documents")),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-ws-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// Two roots that both have `Todo.md` and `Ideas.md`; `a` is a vault, `b` a plain folder.
    fn two_roots(name: &str) -> (PathBuf, PathBuf, Workspace) {
        let base = temp_dir(name);
        let (a, b) = (base.join("alpha"), base.join("beta"));
        write(&a, ".obsidian/app.json", "{}");
        write(&a, "Todo.md", "alpha todo");
        write(&a, "sub/Ideas.md", "alpha ideas");
        write(&a, "OnlyA.md", "x");
        write(&b, "Todo.md", "beta todo");
        write(&b, "Ideas.md", "beta ideas");
        write(&b, "OnlyB.md", "x");
        let mut ws = Workspace::new("both").unwrap();
        ws.add_root(&a, &NONE).unwrap();
        ws.add_root(&b, &NONE).unwrap();
        (a, b, ws)
    }

    #[test]
    fn detects_the_kind_of_each_root() {
        let base = temp_dir("kinds");
        write(&base.join("vault"), ".obsidian/app.json", "{}");
        write(&base.join("wiki"), ".order", "Home\n");
        write(&base.join("wiki2"), ".attachments/a.png", "x");
        write(&base.join("plain"), "a.md", "x");
        assert_eq!(detect_kind(&base.join("vault")), RootKind::Obsidian);
        assert_eq!(detect_kind(&base.join("wiki")), RootKind::Wiki);
        assert_eq!(detect_kind(&base.join("wiki2")), RootKind::Wiki);
        assert_eq!(detect_kind(&base.join("plain")), RootKind::Folder);
    }

    #[test]
    fn adds_roots_with_their_kind_and_unique_names() {
        let base = temp_dir("add");
        write(&base.join("x/notes"), "a.md", "x");
        write(&base.join("y/notes/.obsidian"), "app.json", "{}");
        let mut ws = Workspace::new("w").unwrap();
        let first = ws.add_root(&base.join("x/notes"), &NONE).unwrap();
        let second = ws.add_root(&base.join("y/notes"), &NONE).unwrap();
        assert_eq!(
            (first.name.as_str(), first.kind),
            ("notes", RootKind::Folder)
        );
        assert_eq!(
            (second.name.as_str(), second.kind),
            ("notes (2)", RootKind::Obsidian)
        );
        // The same folder twice is one root.
        assert_eq!(ws.add_root(&base.join("x/notes"), &NONE).unwrap(), first);
        assert_eq!(ws.roots.len(), 2);
        assert!(ws.add_root(&base.join("missing"), &NONE).is_err());
        assert!(ws.remove_root(&first.path));
        assert!(!ws.remove_root(&first.path));
    }

    #[test]
    fn an_obsidian_subfolder_is_added_as_its_vault() {
        let base = temp_dir("vault-sub");
        write(&base.join("v"), ".obsidian/app.json", "{}");
        write(&base.join("v/inner"), "a.md", "x");
        let mut ws = Workspace::new("w").unwrap();
        let root = ws.add_root(&base.join("v/inner"), &NONE).unwrap();
        assert_eq!(root.path, slashes(&base.join("v")));
        assert_eq!(root.kind, RootKind::Obsidian);
    }

    #[test]
    fn a_workspace_is_saved_listed_loaded_and_deleted_without_touching_the_folders() {
        let (a, b, ws) = two_roots("save");
        let snapshot = |p: &Path| vault::list_vault_files(p);
        let (before_a, before_b) = (snapshot(&a), snapshot(&b));
        let app = temp_dir("save-app");
        assert!(list(&app).is_empty());
        save(&app, &ws).unwrap();
        save(&app, &Workspace::new("Another").unwrap()).unwrap();
        assert_eq!(list(&app), vec!["Another", "both"]);
        assert_eq!(load(&app, "both", &NONE).unwrap(), ws);
        assert!(app.join("workspaces/both.json").is_file());
        assert_eq!((snapshot(&a), snapshot(&b)), (before_a, before_b));
        delete(&app, "both").unwrap();
        delete(&app, "both").unwrap();
        assert_eq!(list(&app), vec!["Another"]);
        assert!(load(&app, "both", &NONE).is_err());
    }

    #[test]
    fn refuses_names_that_are_no_file_names() {
        for name in [
            "", " ", "../x", "a/b", "a\\b", ".hidden", "a:b", "nul", "Com1.x", "end.",
        ] {
            assert!(Workspace::new(name).is_err(), "{name}");
        }
        let app = temp_dir("names");
        assert!(load(&app, "../settings", &NONE).is_err());
        assert!(delete(&app, "../settings").is_err());
    }

    #[test]
    fn an_equal_note_name_resolves_inside_its_own_root() {
        let (a, b, ws) = two_roots("equal");
        let links = WorkspaceLinks::new(&ws);
        let (pa, pb) = (slashes(&a), slashes(&b));
        let hit = |from: &str, target: &str| links.resolve(from, target);
        let at = |root: &str, path: &str| {
            Some(ResolvedLink {
                root: root.to_string(),
                path: path.to_string(),
            })
        };
        assert_eq!(hit(&pa, "Todo"), at(&pa, "Todo.md"));
        assert_eq!(hit(&pb, "Todo"), at(&pb, "Todo.md"));
        assert_eq!(hit(&pa, "Ideas"), at(&pa, "sub/Ideas.md"));
        assert_eq!(hit(&pb, "Ideas"), at(&pb, "Ideas.md"));
        // A note of the other root is not found without a prefix.
        assert_eq!(hit(&pa, "OnlyB"), None);
        assert_eq!(hit(&pb, "OnlyA"), None);
    }

    #[test]
    fn a_root_prefix_reaches_a_note_of_another_root() {
        let (a, b, ws) = two_roots("prefix");
        let links = WorkspaceLinks::new(&ws);
        let (pa, pb) = (slashes(&a), slashes(&b));
        let at = |root: &str, path: &str| {
            Some(ResolvedLink {
                root: root.to_string(),
                path: path.to_string(),
            })
        };
        assert_eq!(links.resolve(&pa, "beta:Todo"), at(&pb, "Todo.md"));
        assert_eq!(links.resolve(&pb, "alpha:Todo"), at(&pa, "Todo.md"));
        assert_eq!(
            links.resolve(&pb, "Alpha:sub/Ideas#Heading"),
            at(&pa, "sub/Ideas.md")
        );
        // The prefix of the own root works too; a missing note stays missing.
        assert_eq!(links.resolve(&pa, "alpha:Todo"), at(&pa, "Todo.md"));
        assert_eq!(links.resolve(&pa, "beta:OnlyA"), None);
        // A colon that names no root belongs to the note name.
        write(&a, "Re: plan.md", "x");
        let links = WorkspaceLinks::new(&ws);
        assert_eq!(links.resolve(&pa, "Re: plan"), at(&pa, "Re: plan.md"));
    }

    #[test]
    fn the_resolver_turns_a_leading_variable_into_the_folder_of_the_device() {
        let loc = device(Path::new("/dev"));
        assert_eq!(loc.resolve("$Home/x/y").unwrap(), "/dev/home/x/y");
        assert_eq!(
            loc.resolve("$Documents/Books").unwrap(),
            "/dev/home/Documents/Books"
        );
        assert_eq!(loc.resolve("$Home").unwrap(), "/dev/home");
        assert_eq!(loc.resolve("$Home\\x").unwrap(), "/dev/home/x");
        assert_eq!(loc.resolve("/abs/path").unwrap(), "/abs/path");
    }

    #[test]
    fn a_double_dollar_and_a_dollar_inside_a_path_are_literal() {
        let loc = device(Path::new("/dev"));
        assert_eq!(loc.resolve("$$name").unwrap(), "$name");
        assert_eq!(loc.resolve("$$Home/x").unwrap(), "$Home/x");
        assert_eq!(loc.resolve("/a/$Home/b").unwrap(), "/a/$Home/b");
        assert_eq!(loc.resolve("$/x").unwrap(), "$/x");
    }

    #[test]
    fn an_unknown_variable_or_a_missing_folder_is_named() {
        assert_eq!(
            device(Path::new("/dev")).resolve("$Nope/x"),
            Err("Nope".into())
        );
        assert_eq!(NONE.resolve("$Home/x"), Err("Home".into()));
    }

    #[test]
    fn a_template_root_loads_resolved_and_saves_the_template_again() {
        let base = temp_dir("template");
        let loc = device(&base);
        write(&base.join("home"), "x/Note.md", "hi");
        let app = temp_dir("template-app");
        let mut ws = Workspace::new("t").unwrap();
        let added = ws.add_root(Path::new("$Home/x"), &loc).unwrap();
        assert_eq!(added.template.as_deref(), Some("$Home/x"));
        assert_eq!(added.path, slashes(&base.join("home/x")));
        save(&app, &ws).unwrap();
        let file = fs::read_to_string(app.join("workspaces/t.json")).unwrap();
        assert!(file.contains("\"$Home/x\""));
        assert!(!file.contains("template"));
        assert!(!file.contains(base.to_str().unwrap()));
        let loaded = load(&app, "t", &loc).unwrap();
        assert_eq!(loaded, ws);
        // Another device: same file, other home.
        let other = temp_dir("template-other");
        let there = load(&app, "t", &device(&other)).unwrap();
        assert_eq!(there.roots[0].path, slashes(&other.join("home/x")));
        save(&app, &there).unwrap();
        assert_eq!(
            fs::read_to_string(app.join("workspaces/t.json")).unwrap(),
            file
        );
    }

    #[test]
    fn a_root_with_an_unresolved_variable_is_kept_and_saved_unchanged() {
        let app = temp_dir("unresolved");
        let dir = app.join("workspaces");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("u.json"),
            r#"{"name":"u","roots":[{"path":"$Nope/x","name":"x","kind":"folder"}]}"#,
        )
        .unwrap();
        let ws = load(&app, "u", &NONE).unwrap();
        assert_eq!(ws.roots[0].path, "$Nope/x");
        save(&app, &ws).unwrap();
        let file = fs::read_to_string(dir.join("u.json")).unwrap();
        assert!(file.contains("\"$Nope/x\""));
    }

    #[test]
    fn a_variable_without_a_value_on_the_device_is_refused_when_added() {
        let err = Workspace::new("e")
            .unwrap()
            .add_root(Path::new("$Home/x"), &NONE)
            .unwrap_err();
        assert!(err.contains("$Home"), "{err}");
    }

    #[test]
    fn old_workspace_files_without_a_template_load_unchanged() {
        let base = temp_dir("old");
        let app = temp_dir("old-app");
        let dir = app.join("workspaces");
        fs::create_dir_all(&dir).unwrap();
        let path = slashes(&base);
        fs::write(
            dir.join("o.json"),
            format!(
                r#"{{"name":"o","roots":[{{"path":"{path}","name":"base","kind":"folder"}}]}}"#
            ),
        )
        .unwrap();
        let ws = load(&app, "o", &device(&base)).unwrap();
        assert_eq!(ws.roots[0].path, path);
        assert_eq!(ws.roots[0].template, None);
    }
}
