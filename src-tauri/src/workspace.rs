//! Workspaces (#116): several folders ("roots") in one window. A workspace is a named list of
//! roots, saved in the app data directory (`workspaces/<name>.json`); nothing is written into the
//! folders. Each root keeps its own kind, its own file list (so its own link resolution) and its
//! own index (`index::index_path` is per root path).
//!
//! A wikilink resolves inside the root of the note that holds it. A link to a note of another root
//! names that root with a prefix: `[[Root name:Note]]`, `[[Root name:folder/Note#Heading]]`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::vault::resolve::Resolver;
use crate::vault::{self, find_vault_root};

/// Folder of the saved workspaces inside the app data directory.
pub(crate) const DIR: &str = "workspaces";
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

/// The platform a [`Locations`] is detected for; injected so every branch is testable anywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Other,
}

impl Platform {
    pub const CURRENT: Platform = if cfg!(windows) {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::MacOs
    } else {
        Platform::Other
    };
}

/// Why a leading `$Name` has no folder on this device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unresolved {
    /// The variable is unknown, or has no folder here (Linux has no `$OneDrive`).
    NoValue(String),
    /// Several folders fit (several OneDrive accounts): the user picks one of `candidates`.
    NeedsChoice {
        name: String,
        candidates: Vec<String>,
    },
}

impl std::fmt::Display for Unresolved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unresolved::NoValue(name) => {
                write!(f, "the variable ${name} has no value on this device")
            }
            Unresolved::NeedsChoice { name, candidates } => write!(
                f,
                "the variable ${name} needs a choice on this device: {}",
                candidates.join(", ")
            ),
        }
    }
}

/// The folders the built-in location variables stand for on this device.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Locations {
    pub home: Option<PathBuf>,
    pub documents: Option<PathBuf>,
    /// The OneDrive folder when there is exactly one (or the user chose one).
    pub onedrive: Option<PathBuf>,
    /// Several OneDrive folders and no choice yet: the candidates.
    pub onedrive_candidates: Vec<PathBuf>,
    pub icloud: Option<PathBuf>,
    /// The variables the user defined on this device (#495), by name.
    pub own: BTreeMap<String, PathBuf>,
}

/// Names of the built-in variables; an own variable cannot take one of them.
pub const BUILTIN_VARIABLES: [&str; 4] = ["Home", "Documents", "OneDrive", "iCloud"];

/// File of the own variables of this device inside the app data directory, next to `settings.json`.
/// It is never part of a workspace or a vault.
pub const LOCATIONS_FILE: &str = "locations.json";

/// What `locations.json` holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnLocations {
    /// Own variable names and their absolute folders.
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    /// The OneDrive folder picked among several accounts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub onedrive: Option<String>,
}

impl OwnLocations {
    /// The file of `dir`; missing or damaged text gives no variables.
    pub fn load(dir: &Path) -> OwnLocations {
        fs::read_to_string(dir.join(LOCATIONS_FILE))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    /// Atomically writes the file into `dir`.
    pub fn save(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let target = dir.join(LOCATIONS_FILE);
        let tmp = dir.join(format!(".{LOCATIONS_FILE}.nixe-tmp"));
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
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

    /// Defines or changes the variable `name` as the folder `path`, and drops `previous` (a
    /// rename). The name is letters, digits and `_` and no built-in name (any case); the folder is
    /// an existing absolute one. Nothing changes on an error.
    pub fn set(&mut self, name: &str, path: &str, previous: Option<&str>) -> Result<(), String> {
        let name = name.trim();
        let path = path.trim();
        if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Err(format!(
                "\"{name}\" is no variable name: use letters, digits and _"
            ));
        }
        if BUILTIN_VARIABLES
            .iter()
            .any(|b| b.eq_ignore_ascii_case(name))
        {
            return Err(format!(
                "${name} is a built-in variable and cannot be redefined"
            ));
        }
        if previous != Some(name) && self.variables.contains_key(name) {
            return Err(format!("${name} exists already"));
        }
        let folder = Path::new(path);
        if !folder.is_absolute() {
            return Err(format!("\"{path}\" is not an absolute path"));
        }
        if !folder.is_dir() {
            return Err(format!("\"{path}\" is not an existing folder"));
        }
        if let Some(previous) = previous {
            self.variables.remove(previous);
        }
        self.variables.insert(name.to_string(), path.to_string());
        Ok(())
    }

    /// Forgets the variable `name`; whether there was one.
    pub fn remove(&mut self, name: &str) -> bool {
        self.variables.remove(name).is_some()
    }
}

impl Locations {
    /// Adds the own variables and the OneDrive choice stored in the app data directory `dir`.
    pub fn with_own(mut self, dir: &Path) -> Locations {
        let own = OwnLocations::load(dir);
        self.own = own
            .variables
            .into_iter()
            .filter(|(name, _)| {
                !BUILTIN_VARIABLES
                    .iter()
                    .any(|b| b.eq_ignore_ascii_case(name))
            })
            .map(|(name, path)| (name, PathBuf::from(path)))
            .collect();
        if let Some(choice) = own.onedrive {
            self.choose_onedrive(Path::new(&choice));
        }
        self
    }

    /// Without a running app (command line, MCP): the home folder from the environment, the
    /// documents folder below it.
    pub fn from_env() -> Locations {
        let home = ["HOME", "USERPROFILE"]
            .iter()
            .filter_map(std::env::var_os)
            .find(|v| !v.is_empty())
            .map(PathBuf::from);
        let onedrive_env = std::env::var_os("OneDrive")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let documents = home.as_ref().map(|h| h.join("Documents"));
        Locations {
            documents,
            ..Locations::with_cloud(Platform::CURRENT, home, onedrive_env, &list_dirs)
        }
    }

    /// From the Tauri path API.
    pub fn from_app<R: tauri::Runtime>(app: &impl tauri::Manager<R>) -> Locations {
        let paths = app.path();
        let onedrive_env = std::env::var_os("OneDrive")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let loc = Locations {
            documents: paths.document_dir().ok(),
            ..Locations::with_cloud(
                Platform::CURRENT,
                paths.home_dir().ok(),
                onedrive_env,
                &list_dirs,
            )
        };
        match paths.app_data_dir() {
            Ok(dir) => loc.with_own(&dir),
            Err(_) => loc,
        }
    }

    /// `home`, `$OneDrive` and `$iCloud` for `platform` from an injected environment: the value of
    /// the `OneDrive` variable (Windows) and a directory listing (macOS), so a test reads nothing
    /// of the real device. `documents` stays unset.
    pub fn with_cloud(
        platform: Platform,
        home: Option<PathBuf>,
        onedrive_env: Option<PathBuf>,
        list: &dyn Fn(&Path) -> Vec<PathBuf>,
    ) -> Locations {
        let mut loc = Locations {
            home: home.clone(),
            ..Locations::default()
        };
        match (platform, &home) {
            (Platform::Windows, _) => loc.onedrive = onedrive_env,
            (Platform::MacOs, Some(home)) => {
                let mut found: Vec<PathBuf> = list(&home.join("Library/CloudStorage"))
                    .into_iter()
                    .filter(|p| {
                        p.file_name()
                            .is_some_and(|n| n.to_string_lossy().starts_with("OneDrive-"))
                    })
                    .collect();
                found.sort();
                if found.len() == 1 {
                    loc.onedrive = found.pop();
                } else {
                    loc.onedrive_candidates = found;
                }
                loc.icloud = Some(home.join("Library/Mobile Documents/com~apple~CloudDocs"));
            }
            _ => {}
        }
        loc
    }

    /// Settles `$OneDrive` with the folder the user picked among the candidates (stored per
    /// device, #495). A folder that is no candidate is ignored.
    pub fn choose_onedrive(&mut self, choice: &Path) {
        if self.onedrive_candidates.iter().any(|c| c == choice) {
            self.onedrive = Some(choice.to_path_buf());
            self.onedrive_candidates.clear();
        }
    }

    fn get(&self, name: &str) -> Result<&Path, Unresolved> {
        let none = || Unresolved::NoValue(name.to_string());
        match name {
            "Home" => self.home.as_deref().ok_or_else(none),
            "Documents" => self.documents.as_deref().ok_or_else(none),
            "iCloud" => self.icloud.as_deref().ok_or_else(none),
            "OneDrive" => match self.onedrive.as_deref() {
                Some(p) => Ok(p),
                None if self.onedrive_candidates.len() > 1 => Err(Unresolved::NeedsChoice {
                    name: name.to_string(),
                    candidates: self
                        .onedrive_candidates
                        .iter()
                        .map(|c| slashes(c))
                        .collect(),
                }),
                None => Err(none()),
            },
            _ => self.own.get(name).map(PathBuf::as_path).ok_or_else(none),
        }
    }

    /// Resolves a path written with a leading `$Name`: `$Home/x` becomes the home folder of this
    /// device plus `x`; `$$name` is the literal `$name`. A `$` anywhere else, or a `$` that no
    /// name follows, is literal. A path that does not start with `$` is returned as it is. The
    /// error says whether the variable has no value here or needs a choice among candidates.
    pub fn resolve(&self, template: &str) -> Result<String, Unresolved> {
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
        let base = self.get(name)?;
        let tail = tail.trim_start_matches(['/', '\\']);
        Ok(if tail.is_empty() {
            slashes(base)
        } else {
            slashes(&base.join(tail))
        })
    }
}

/// A way to store a folder as `$Name/rest` (#498).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VariableChoice {
    /// The variable without `$`.
    pub name: String,
    /// The path as it would be stored: `$Name/rest`, or `$Name` for the folder itself.
    pub template: String,
    /// The absolute path it resolves to on this device, forward slashes.
    pub resolved: String,
}

impl Locations {
    /// The variables whose folder contains `path` (or is `path`), the deepest folder first, each
    /// with the template it would store. Empty for a folder elsewhere, which stays an absolute
    /// path. Variables without a value on this device are not offered.
    pub fn choices_for(&self, path: &Path) -> Vec<VariableChoice> {
        let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let target = canon(path);
        let mut names: Vec<&str> = BUILTIN_VARIABLES.to_vec();
        names.extend(self.own.keys().map(String::as_str));
        let mut found: Vec<(usize, VariableChoice)> = names
            .into_iter()
            .filter_map(|name| {
                let base = canon(self.get(name).ok()?);
                let rest = target.strip_prefix(&base).ok()?;
                let rest = slashes(rest);
                let template = if rest.is_empty() {
                    format!("${name}")
                } else {
                    format!("${name}/{rest}")
                };
                Some((
                    base.components().count(),
                    VariableChoice {
                        name: name.to_string(),
                        template,
                        resolved: slashes(&target),
                    },
                ))
            })
            .collect();
        found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
        found.into_iter().map(|(_, c)| c).collect()
    }
}

/// The sub-directories of `dir`; empty when it cannot be read.
fn list_dirs(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default()
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
            Some(t) => PathBuf::from(locations.resolve(t).map_err(|e| format!("{t}: {e}"))?),
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

    /// Gives the root at `path` the name `name` (#497): the prefix of its links on every device,
    /// whatever the folder is called. The name is trimmed; it must be a valid link prefix and
    /// differ (case-insensitive) from the name of every other root. Links under the old name are
    /// not rewritten. Returns the stored name.
    pub fn rename_root(&mut self, path: &str, name: &str) -> Result<String, String> {
        let name = valid_root_name(name)?;
        if !self.roots.iter().any(|r| r.path == path) {
            return Err(format!("{path}: not a root of this workspace"));
        }
        if self
            .roots
            .iter()
            .any(|r| r.path != path && r.name.eq_ignore_ascii_case(&name))
        {
            return Err(format!("another root is called \"{name}\" already"));
        }
        let root = self
            .roots
            .iter_mut()
            .find(|r| r.path == path)
            .expect("checked above");
        root.name.clone_from(&name);
        Ok(name)
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

/// A root name that works as the prefix of a link (`[[Name:Note]]`): not empty, at most 100
/// characters, no `:` (it ends the prefix) and none of the characters that end or split a link.
fn valid_root_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let bad = name.is_empty()
        || name.chars().count() > 100
        || name.chars().any(|c| c.is_control() || ":[]|#^".contains(c));
    if bad {
        Err(format!(
            "\"{name}\" is not a valid root name (not empty, none of : [ ] | # ^)"
        ))
    } else {
        Ok(name.to_string())
    }
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
    use crate::test_dir::TestDir;

    const NONE: Locations = Locations {
        home: None,
        documents: None,
        onedrive: None,
        onedrive_candidates: Vec::new(),
        icloud: None,
        own: BTreeMap::new(),
    };

    fn device(base: &Path) -> Locations {
        Locations {
            home: Some(base.join("home")),
            documents: Some(base.join("home/Documents")),
            ..Locations::default()
        }
    }

    fn temp_dir(name: &str) -> TestDir {
        TestDir::new(&format!("nixe-ws-{name}-"))
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// Two roots that both have `Todo.md` and `Ideas.md`; `a` is a vault, `b` a plain folder.
    /// The first element is the scratch directory of both roots.
    fn two_roots(name: &str) -> (TestDir, PathBuf, PathBuf, Workspace) {
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
        (base, a, b, ws)
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
        let (_base, a, b, ws) = two_roots("save");
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
        let (_base, a, b, ws) = two_roots("equal");
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
    fn a_renamed_root_resolves_under_the_new_name_only_and_keeps_it_when_saved() {
        let (_base, a, b, mut ws) = two_roots("rename");
        let (pa, pb) = (slashes(&a), slashes(&b));
        assert_eq!(ws.rename_root(&pb, "  Books ").unwrap(), "Books");
        let links = WorkspaceLinks::new(&ws);
        let at = Some(ResolvedLink {
            root: pb.clone(),
            path: "Todo.md".to_string(),
        });
        assert_eq!(links.resolve(&pa, "Books:Todo"), at);
        assert_eq!(links.resolve(&pa, "beta:Todo"), None);
        // The new name survives save and load, and differs from the folder name.
        let app = temp_dir("rename-app");
        ws.name = "Mine".to_string();
        save(&app, &ws).unwrap();
        let loaded = load(&app, "Mine", &NONE).unwrap();
        assert_eq!(loaded.roots[1].name, "Books");
        assert_eq!(loaded, ws);
    }

    #[test]
    fn a_root_name_that_clashes_or_cannot_be_a_link_prefix_is_refused() {
        let (_base, a, b, mut ws) = two_roots("rename-bad");
        let (pa, pb) = (slashes(&a), slashes(&b));
        let other = ws.roots[0].name.clone();
        assert!(ws.rename_root(&pb, &other.to_uppercase()).is_err());
        for bad in ["", "   ", "A:B", "a]b", "a|b", "a#b", "a[b", "a\nb"] {
            assert!(ws.rename_root(&pb, bad).is_err(), "{bad:?}");
        }
        assert!(ws.rename_root("/nowhere", "Fine").is_err());
        assert_eq!(ws.roots[1].name, "beta");
        // The root's own name in another case is no clash.
        assert_eq!(ws.rename_root(&pb, "BETA").unwrap(), "BETA");
        assert_eq!(ws.rename_root(&pa, "alpha").unwrap(), "alpha");
    }

    #[test]
    fn a_root_prefix_reaches_a_note_of_another_root() {
        let (_base, a, b, ws) = two_roots("prefix");
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
    fn a_root_prefix_reaches_a_book_of_another_root() {
        let (_dir, a, b, ws) = two_roots("prefix-book");
        write(&b, "Shelf/Novel.epub", "x");
        let links = WorkspaceLinks::new(&ws);
        let (pa, pb) = (slashes(&a), slashes(&b));
        let hit = Some(ResolvedLink {
            root: pb.clone(),
            path: "Shelf/Novel.epub".to_string(),
        });
        assert_eq!(links.resolve(&pa, "beta:Novel.epub"), hit);
        assert_eq!(links.resolve(&pa, "beta:Shelf/Novel.epub"), hit);
        assert_eq!(links.resolve(&pb, "Novel.epub"), hit);
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

    fn listing(entries: &'static [&'static str]) -> impl Fn(&Path) -> Vec<PathBuf> {
        move |dir| {
            assert_eq!(dir, Path::new("/u/Library/CloudStorage"));
            entries.iter().map(|e| dir.join(e)).collect()
        }
    }

    fn cloud(platform: Platform, env: Option<&str>, entries: &'static [&'static str]) -> Locations {
        Locations::with_cloud(
            platform,
            Some(PathBuf::from("/u")),
            env.map(PathBuf::from),
            &listing(entries),
        )
    }

    #[test]
    fn onedrive_on_windows_is_the_environment_variable() {
        let loc = cloud(Platform::Windows, Some("C:/Users/u/OneDrive"), &[]);
        assert_eq!(
            loc.resolve("$OneDrive/Books").unwrap(),
            "C:/Users/u/OneDrive/Books"
        );
        assert_eq!(loc.icloud, None);
        let none = cloud(Platform::Windows, None, &[]);
        assert_eq!(
            none.resolve("$OneDrive"),
            Err(Unresolved::NoValue("OneDrive".into()))
        );
    }

    #[test]
    fn onedrive_on_macos_is_the_one_cloud_storage_folder() {
        let loc = cloud(
            Platform::MacOs,
            None,
            &["OneDrive-Personal", "Dropbox", "GoogleDrive-a"],
        );
        assert_eq!(
            loc.resolve("$OneDrive/x").unwrap(),
            "/u/Library/CloudStorage/OneDrive-Personal/x"
        );
        assert_eq!(
            cloud(Platform::MacOs, None, &["Dropbox"]).resolve("$OneDrive"),
            Err(Unresolved::NoValue("OneDrive".into()))
        );
    }

    #[test]
    fn several_onedrive_folders_need_a_choice_that_names_them() {
        let mut loc = cloud(
            Platform::MacOs,
            None,
            &["OneDrive-Work", "OneDrive-Personal"],
        );
        let err = loc.resolve("$OneDrive/x").unwrap_err();
        assert_eq!(
            err,
            Unresolved::NeedsChoice {
                name: "OneDrive".into(),
                candidates: vec![
                    "/u/Library/CloudStorage/OneDrive-Personal".into(),
                    "/u/Library/CloudStorage/OneDrive-Work".into(),
                ],
            }
        );
        assert!(err.to_string().contains("OneDrive-Work"));
        loc.choose_onedrive(Path::new("/elsewhere"));
        assert!(loc.resolve("$OneDrive").is_err());
        loc.choose_onedrive(Path::new("/u/Library/CloudStorage/OneDrive-Work"));
        assert_eq!(
            loc.resolve("$OneDrive/x").unwrap(),
            "/u/Library/CloudStorage/OneDrive-Work/x"
        );
    }

    #[test]
    fn icloud_is_the_cloud_docs_folder_on_macos_only() {
        let mac = cloud(Platform::MacOs, None, &[]);
        assert_eq!(
            mac.resolve("$iCloud/n").unwrap(),
            "/u/Library/Mobile Documents/com~apple~CloudDocs/n"
        );
        for p in [Platform::Windows, Platform::Other] {
            assert_eq!(
                cloud(p, None, &[]).resolve("$iCloud"),
                Err(Unresolved::NoValue("iCloud".into()))
            );
        }
    }

    #[test]
    fn linux_has_neither_cloud_variable() {
        let loc = cloud(Platform::Other, Some("/ignored"), &["OneDrive-X"]);
        assert!(loc.resolve("$OneDrive").is_err());
        assert!(loc.resolve("$iCloud").is_err());
        assert_eq!(loc.resolve("$Home/x").unwrap(), "/u/x");
    }

    #[test]
    fn a_choice_is_named_when_a_root_is_added() {
        let loc = cloud(Platform::MacOs, None, &["OneDrive-A", "OneDrive-B"]);
        let err = Workspace::new("c")
            .unwrap()
            .add_root(Path::new("$OneDrive/x"), &loc)
            .unwrap_err();
        assert!(
            err.contains("needs a choice") && err.contains("OneDrive-A"),
            "{err}"
        );
    }

    #[test]
    fn an_own_variable_resolves_and_a_built_in_name_is_reserved() {
        let dir = temp_dir("own");
        let books = dir.join("Books");
        fs::create_dir_all(&books).unwrap();
        let mut own = OwnLocations::default();
        own.set("Books", books.to_str().unwrap(), None).unwrap();
        for reserved in ["Home", "home", "OneDrive", "iCloud", "Documents"] {
            let err = own
                .set(reserved, books.to_str().unwrap(), None)
                .unwrap_err();
            assert!(err.contains("built-in"), "{err}");
        }
        own.save(&dir).unwrap();
        let loc = device(&dir).with_own(&dir);
        assert_eq!(
            loc.resolve("$Books/x").unwrap(),
            format!("{}/x", slashes(&books))
        );
        assert_eq!(
            device(&dir).resolve("$Books").unwrap_err(),
            Unresolved::NoValue("Books".into())
        );
    }

    #[test]
    fn an_own_variable_needs_an_existing_absolute_folder_and_a_plain_name() {
        let dir = temp_dir("own-bad");
        let mut own = OwnLocations::default();
        let ok = dir.to_str().unwrap();
        assert!(own
            .set("Books", "relative/dir", None)
            .unwrap_err()
            .contains("absolute"));
        let missing = dir.join("missing");
        assert!(own
            .set("Books", missing.to_str().unwrap(), None)
            .unwrap_err()
            .contains("existing folder"));
        assert!(own.set("my books", ok, None).is_err());
        assert!(own.set("", ok, None).is_err());
        assert!(own.set("a/b", ok, None).is_err());
        assert!(own.variables.is_empty());
    }

    #[test]
    fn an_own_variable_is_added_edited_renamed_and_removed() {
        let dir = temp_dir("own-edit");
        let a = dir.join("a");
        let b = dir.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let (a, b) = (a.to_str().unwrap(), b.to_str().unwrap());
        let mut own = OwnLocations::default();
        own.set("Books", a, None).unwrap();
        assert!(own.set("Books", b, None).unwrap_err().contains("exists"));
        own.set("Books", b, Some("Books")).unwrap();
        assert_eq!(own.variables["Books"], b);
        own.set("Library", b, Some("Books")).unwrap();
        assert_eq!(own.variables.keys().collect::<Vec<_>>(), ["Library"]);
        own.save(&dir).unwrap();
        assert_eq!(OwnLocations::load(&dir), own);
        assert!(own.remove("Library"));
        assert!(!own.remove("Library"));
        own.save(&dir).unwrap();
        assert!(OwnLocations::load(&dir).variables.is_empty());
    }

    #[test]
    fn the_stored_onedrive_choice_settles_the_candidates_and_a_damaged_file_is_ignored() {
        let dir = temp_dir("own-choice");
        let work = "/u/Library/CloudStorage/OneDrive-Work";
        let own = OwnLocations {
            onedrive: Some(work.into()),
            ..OwnLocations::default()
        };
        own.save(&dir).unwrap();
        let loc = cloud(
            Platform::MacOs,
            None,
            &[
                "/u/Library/CloudStorage/OneDrive-Work",
                "/u/Library/CloudStorage/OneDrive-Home",
            ],
        )
        .with_own(&dir);
        assert_eq!(loc.resolve("$OneDrive/x").unwrap(), format!("{work}/x"));
        fs::write(dir.join(LOCATIONS_FILE), "{ damaged").unwrap();
        assert_eq!(OwnLocations::load(&dir), OwnLocations::default());
    }

    #[test]
    fn a_folder_below_a_variable_offers_its_template_deepest_first() {
        let base = temp_dir("choices");
        let books = base.join("home/Documents/Books/fiction");
        fs::create_dir_all(&books).unwrap();
        let mut loc = device(&base);
        loc.own
            .insert("Books".into(), base.join("home/Documents/Books"));
        let got = loc.choices_for(&books);
        let templates: Vec<_> = got.iter().map(|c| c.template.as_str()).collect();
        assert_eq!(
            templates,
            [
                "$Books/fiction",
                "$Documents/Books/fiction",
                "$Home/Documents/Books/fiction"
            ]
        );
        assert!(got.iter().all(|c| c.resolved == slashes(&books)));
        // The variable's own folder is offered as the bare variable.
        let own = base.join("home/Documents/Books");
        assert_eq!(loc.choices_for(&own)[0].template, "$Books");
        // A resolved choice round-trips through add_root and keeps the template.
        let mut ws = Workspace::new("w").unwrap();
        let root = ws.add_root(Path::new(&got[0].template), &loc).unwrap();
        assert_eq!(root.template.as_deref(), Some("$Books/fiction"));
        assert_eq!(root.path, slashes(&books));
    }

    #[test]
    fn a_folder_elsewhere_or_a_variable_without_value_offers_nothing() {
        let base = temp_dir("choices-none");
        let elsewhere = base.join("other/notes");
        fs::create_dir_all(&elsewhere).unwrap();
        assert!(device(&base).choices_for(&elsewhere).is_empty());
        assert!(NONE.choices_for(&base.join("home")).is_empty());
        // A sibling that only shares a name prefix is not below the variable.
        let sibling = base.join("home/Documents2");
        fs::create_dir_all(&sibling).unwrap();
        let got = device(&base).choices_for(&sibling);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "Home");
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
            Err(Unresolved::NoValue("Nope".into()))
        );
        assert_eq!(
            NONE.resolve("$Home/x"),
            Err(Unresolved::NoValue("Home".into()))
        );
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
