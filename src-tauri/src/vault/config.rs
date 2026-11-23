//! The vault configuration `.nixe/config.json` (ADR 0007, #439): `language`, `folders`, `files`
//! and the sections `newNotes`, `templates` and `daily`. It is read per key; a key it does not
//! set comes from `.obsidian/` (until the expiry of the fallback). The writers (#446) set and remove
//! a folder role and follow a rename; they keep the other keys and their order.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path};

use serde::Serialize;
use serde_json::{Map, Value};

/// The vault-relative path of the configuration file, as the settings page shows it.
pub const SOURCE: &str = ".nixe/config.json";

/// A `folders` or `files` entry: a path, or an object with `path` and `description`. The keys of
/// the object that Nixe does not know are kept (`extra`) so a write gives them back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub path: String,
    pub description: Option<String>,
    #[serde(skip)]
    pub extra: Map<String, Value>,
    /// Set by `layout` for the frontend: the folder or file of the entry does not exist.
    pub missing: bool,
}

impl Entry {
    fn from_value(value: &Value) -> Option<Entry> {
        match value {
            Value::String(path) => Some(Entry {
                path: path.clone(),
                description: None,
                extra: Map::new(),
                missing: false,
            }),
            Value::Object(object) => {
                let mut extra = object.clone();
                let path = extra.remove("path")?.as_str()?.to_string();
                let description = match extra.remove("description") {
                    Some(Value::String(d)) => Some(d),
                    Some(other) => {
                        // Not a string: kept as it was.
                        extra.insert("description".into(), other);
                        None
                    }
                    None => None,
                };
                Some(Entry {
                    path,
                    description,
                    extra,
                    missing: false,
                })
            }
            _ => None,
        }
    }

    /// The JSON form for a write: the short form when the entry is only a path.
    pub fn to_value(&self) -> Value {
        if self.description.is_none() && self.extra.is_empty() {
            return Value::String(self.path.clone());
        }
        let mut object = Map::new();
        object.insert("path".into(), Value::String(self.path.clone()));
        if let Some(d) = &self.description {
            object.insert("description".into(), Value::String(d.clone()));
        }
        for (k, v) in &self.extra {
            object.insert(k.clone(), v.clone());
        }
        Value::Object(object)
    }
}

/// What the frontend gets of the configuration.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct Layout {
    pub language: Option<String>,
    pub folders: BTreeMap<String, Entry>,
    pub files: BTreeMap<String, Entry>,
}

/// `.nixe/config.json` of a vault; empty when the file is missing or invalid.
#[derive(Debug, Default, Clone)]
pub struct Config {
    json: Map<String, Value>,
}

/// A vault-relative path with forward slashes and without outer slashes. `None` for an empty one;
/// `Err` for one that leaves the vault (`..`, a drive or an absolute path).
fn vault_path(raw: &str) -> Result<Option<String>, ()> {
    let path = raw.trim().replace('\\', "/");
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    // A leading `/` is the vault root, as in Obsidian; a drive or a UNC path is outside.
    let outside = path.starts_with("//")
        || path.as_bytes().get(1) == Some(&b':')
        || Path::new(trimmed)
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)));
    if outside {
        return Err(());
    }
    Ok(Some(trimmed.to_string()))
}

impl Config {
    /// Reads `.nixe/config.json`. A file that is no JSON object is a warning and reads as missing.
    pub fn load(root: &Path) -> Config {
        let text = match fs::read_to_string(root.join(SOURCE)) {
            Ok(text) => text,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("{SOURCE}: {e}; read as missing");
                }
                return Config::default();
            }
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(json)) => Config { json },
            Ok(_) => {
                log::warn!("{SOURCE} is not a JSON object; read as missing");
                Config::default()
            }
            Err(e) => {
                log::warn!("{SOURCE} is invalid ({e}); read as missing");
                Config::default()
            }
        }
    }

    fn section(&self, name: &str, key: &str) -> Option<&Value> {
        self.json.get(name)?.as_object()?.get(key)
    }

    /// A folder or file path of the configuration; one outside the vault is a warning and unset.
    fn checked(&self, what: &str, raw: &str) -> Option<String> {
        match vault_path(raw) {
            Ok(path) => path,
            Err(()) => {
                log::warn!("{SOURCE}: {what} \"{raw}\" is outside the vault; ignored");
                None
            }
        }
    }

    fn section_path(&self, name: &str, key: &str) -> Option<String> {
        let raw = self.section(name, key)?.as_str()?;
        self.checked(&format!("{name}.{key}"), raw)
    }

    fn section_text(&self, name: &str, key: &str) -> Option<String> {
        let value = self.section(name, key)?.as_str()?.trim();
        (!value.is_empty()).then(|| value.to_string())
    }

    /// The `language` key (BCP 47); `None` when it is not set.
    pub fn language(&self) -> Option<String> {
        let value = self.json.get("language")?.as_str()?.trim();
        (!value.is_empty()).then(|| value.to_string())
    }

    fn entries(&self, name: &str) -> BTreeMap<String, Entry> {
        let Some(object) = self.json.get(name).and_then(Value::as_object) else {
            return BTreeMap::new();
        };
        let mut out = BTreeMap::new();
        for (role, value) in object {
            let Some(mut entry) = Entry::from_value(value) else {
                log::warn!("{SOURCE}: {name}.{role} is neither a path nor an object with a path");
                continue;
            };
            let Some(path) = self.checked(&format!("{name}.{role}"), &entry.path) else {
                continue;
            };
            entry.path = path;
            out.insert(role.clone(), entry);
        }
        out
    }

    /// `folders`, by role, with the paths checked.
    pub fn folders(&self) -> BTreeMap<String, Entry> {
        self.entries("folders")
    }

    /// `files`, by role, with the paths checked.
    pub fn files(&self) -> BTreeMap<String, Entry> {
        self.entries("files")
    }

    /// The path of the folder role `role`; `None` when it is not set or points outside the vault.
    pub fn role_folder(&self, role: &str) -> Option<String> {
        let entry = Entry::from_value(self.section("folders", role)?)?;
        self.checked(&format!("folders.{role}"), &entry.path)
    }

    /// The template folder: `templates.folder`, else the role `templates`.
    pub fn template_folder(&self) -> Option<String> {
        self.section_path("templates", "folder")
            .or_else(|| self.role_folder("templates"))
    }

    /// The daily notes folder: `daily.folder`, else the role `journal`.
    pub fn daily_folder(&self) -> Option<String> {
        self.section_path("daily", "folder")
            .or_else(|| self.role_folder("journal"))
    }

    pub fn daily_format(&self) -> Option<String> {
        self.section_text("daily", "format")
    }

    pub fn daily_template(&self) -> Option<String> {
        self.section_path("daily", "template")
    }

    /// The attachment folder: the role `attachments`.
    pub fn attachment_folder(&self) -> Option<String> {
        self.role_folder("attachments")
    }

    /// The folder of new notes: `newNotes.folder`, else the role `inbox`; `None` leaves the
    /// decision to `.obsidian/` and then to the vault root.
    pub fn new_note_folder(&self) -> Option<String> {
        self.section_path("newNotes", "folder")
            .or_else(|| self.role_folder("inbox"))
    }

    pub fn layout(&self) -> Layout {
        Layout {
            language: self.language(),
            folders: self.folders(),
            files: self.files(),
        }
    }
}

/// The layout of the open vault for the frontend; an entry whose path does not exist is marked.
pub fn layout(root: &Path) -> Layout {
    let mut layout = Config::load(root).layout();
    for entry in layout.folders.values_mut().chain(layout.files.values_mut()) {
        entry.missing = !root.join(&entry.path).exists();
    }
    layout
}

/// The standard folder roles (ADR 0007); every other role name is an own role and needs a description.
pub const STANDARD_FOLDER_ROLES: &[&str] = &[
    "inbox",
    "journal",
    "templates",
    "attachments",
    "projects",
    "areas",
    "resources",
    "archive",
    "clippings",
    "subjects",
    "sources",
    "exams",
];

/// The `schemaVersion` this Nixe writes; a file with a newer one is not written.
const SCHEMA_VERSION: i64 = 1;

/// Reads the file for a write: a missing file is an empty object, an invalid or newer one an error
/// (it is never overwritten).
fn load_for_write(root: &Path) -> Result<Map<String, Value>, String> {
    let text = match fs::read_to_string(root.join(SOURCE)) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("{SOURCE}: {e}")),
    };
    let json = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(json)) => json,
        _ => return Err(format!("{SOURCE} is not a valid JSON object; not changed")),
    };
    if json
        .get("schemaVersion")
        .and_then(Value::as_i64)
        .is_some_and(|v| v > SCHEMA_VERSION)
    {
        return Err(format!("{SOURCE} has a newer schemaVersion; not changed"));
    }
    Ok(json)
}

fn save(root: &Path, json: Map<String, Value>) -> Result<(), String> {
    fs::create_dir_all(root.join(".nixe")).map_err(|e| format!(".nixe: {e}"))?;
    let mut text = serde_json::to_string_pretty(&Value::Object(json)).map_err(|e| e.to_string())?;
    text.push('\n');
    crate::write::write_text_file(root, &root.join(SOURCE), &text)
}

fn valid_role_name(role: &str) -> bool {
    !role.is_empty()
        && role
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

/// Sets the folder role `role` on the folder `path` (vault-relative). A folder has at most one
/// role: another one is refused (remove it first); the same role again changes its description. A role name is unique, a path outside the vault is refused, and
/// an own role (not a standard one) needs a description. Every other key stays, in its order.
pub fn set_folder_role(
    root: &Path,
    path: &str,
    role: &str,
    description: Option<&str>,
) -> Result<(), String> {
    let role = role.trim();
    if !valid_role_name(role) {
        return Err("A role name has letters, digits, - and _ only.".into());
    }
    let path = match vault_path(path) {
        Ok(Some(path)) => path,
        Ok(None) => return Err("The vault root cannot have a role.".into()),
        Err(()) => return Err(format!("{path} is outside the vault")),
    };
    let description = description.map(str::trim).filter(|d| !d.is_empty());
    if description.is_none() && !STANDARD_FOLDER_ROLES.contains(&role) {
        return Err(format!("An own role needs a description: {role}"));
    }
    let mut json = load_for_write(root)?;
    let mut folders = match json.get("folders") {
        Some(Value::Object(folders)) => folders.clone(),
        Some(_) => return Err(format!("{SOURCE}: folders is not an object; not changed")),
        None => Map::new(),
    };
    for (name, value) in &folders {
        let Some(entry) = Entry::from_value(value) else {
            continue;
        };
        let same_path = vault_path(&entry.path).ok().flatten().as_deref() == Some(path.as_str());
        if name == role && !same_path {
            return Err(format!("The role {role} is already set on {}.", entry.path));
        }
        if same_path && name != role {
            return Err(format!(
                "{path} has the role {name} already; remove it first."
            ));
        }
    }
    // The same role again keeps the unknown keys of its entry.
    let mut entry = folders
        .get(role)
        .and_then(Entry::from_value)
        .unwrap_or(Entry {
            path: path.clone(),
            description: None,
            extra: Map::new(),
            missing: false,
        });
    entry.path = path;
    entry.description = description.map(str::to_string);
    folders.insert(role.into(), entry.to_value());
    json.insert("folders".into(), Value::Object(folders));
    ensure_schema_version(&mut json);
    save(root, json)
}

fn ensure_schema_version(json: &mut Map<String, Value>) {
    json.entry("schemaVersion")
        .or_insert(Value::from(SCHEMA_VERSION));
}

/// Removes the role of the folder `path`; `false` when it has none. The folder stays on disk.
pub fn remove_folder_role(root: &Path, path: &str) -> Result<bool, String> {
    let path = match vault_path(path) {
        Ok(Some(path)) => path,
        Ok(None) => return Ok(false),
        Err(()) => return Err(format!("{path} is outside the vault")),
    };
    let mut json = load_for_write(root)?;
    let Some(Value::Object(folders)) = json.get_mut("folders") else {
        return Ok(false);
    };
    let found: Vec<String> = folders
        .iter()
        .filter(|(_, v)| {
            Entry::from_value(v)
                .and_then(|e| vault_path(&e.path).ok().flatten())
                .as_deref()
                == Some(path.as_str())
        })
        .map(|(k, _)| k.clone())
        .collect();
    if found.is_empty() {
        return Ok(false);
    }
    for role in found {
        folders.shift_remove(&role);
    }
    save(root, json)?;
    Ok(true)
}

/// `path` after `from` became `to`; `None` when `path` is neither `from` nor below it.
fn moved_path(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    let rest = path.strip_prefix(from)?.strip_prefix('/')?;
    Some(format!("{to}/{rest}"))
}

/// Follows the rename or move of `from` to `to` (vault-relative): the path of every role in
/// `folders` and `files` that is `from` or below it becomes the path under `to`. Returns how many
/// were changed; the file is not written when none is.
pub fn rename_roles(root: &Path, from: &str, to: &str) -> Result<usize, String> {
    let (Ok(Some(from)), Ok(Some(to))) = (vault_path(from), vault_path(to)) else {
        return Ok(0);
    };
    let mut json = match load_for_write(root) {
        Ok(json) => json,
        // Without a readable file there is nothing to follow.
        Err(_) if !root.join(SOURCE).exists() => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut changed = 0;
    for section in ["folders", "files"] {
        let Some(Value::Object(entries)) = json.get_mut(section) else {
            continue;
        };
        for value in entries.values_mut() {
            let Some(mut entry) = Entry::from_value(value) else {
                continue;
            };
            let Some(current) = vault_path(&entry.path).ok().flatten() else {
                continue;
            };
            if let Some(moved) = moved_path(&current, &from, &to) {
                entry.path = moved;
                *value = entry.to_value();
                changed += 1;
            }
        }
    }
    if changed > 0 {
        save(root, json)?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn vault(name: &str, config: Option<&str>) -> PathBuf {
        let root = std::env::temp_dir().join(format!("nixe-config-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".nixe")).unwrap();
        if let Some(text) = config {
            fs::write(root.join(SOURCE), text).unwrap();
        }
        root
    }

    #[test]
    fn a_role_that_is_set_resolves_in_both_forms() {
        let root = vault(
            "roles",
            Some(
                r#"{"folders":{"templates":"Vorlagen","journal":{"path":"Tage/","description":"daily"}}}"#,
            ),
        );
        let config = Config::load(&root);
        assert_eq!(config.template_folder().as_deref(), Some("Vorlagen"));
        assert_eq!(config.daily_folder().as_deref(), Some("Tage"));
    }

    #[test]
    fn a_missing_role_resolves_to_none() {
        let root = vault("missing", Some(r#"{"folders":{"inbox":"Inbox"}}"#));
        let config = Config::load(&root);
        assert_eq!(config.new_note_folder().as_deref(), Some("Inbox"));
        assert_eq!(config.template_folder(), None);
        assert_eq!(config.attachment_folder(), None);
        assert_eq!(config.daily_folder(), None);
    }

    #[test]
    fn a_role_outside_the_vault_is_rejected() {
        let root = vault(
            "outside",
            Some(
                r#"{"folders":{"templates":"../Other","attachments":"C:/Users","journal":"a/../../b","inbox":{"path":"..","description":"x"}}}"#,
            ),
        );
        let config = Config::load(&root);
        assert_eq!(config.template_folder(), None);
        assert_eq!(config.attachment_folder(), None);
        assert_eq!(config.daily_folder(), None);
        assert_eq!(config.new_note_folder(), None);
        assert!(config.folders().is_empty());
    }

    #[test]
    fn the_specific_key_wins_over_the_role() {
        let root = vault(
            "specific",
            Some(
                r#"{"folders":{"templates":"A","journal":"B","inbox":"C"},
                    "templates":{"folder":"T"},"daily":{"folder":"D"},"newNotes":{"folder":"N"}}"#,
            ),
        );
        let config = Config::load(&root);
        assert_eq!(config.template_folder().as_deref(), Some("T"));
        assert_eq!(config.daily_folder().as_deref(), Some("D"));
        assert_eq!(config.new_note_folder().as_deref(), Some("N"));
    }

    #[test]
    fn an_invalid_file_reads_as_missing() {
        for text in ["{ not json", "[1]", "\"x\""] {
            let root = vault("invalid", Some(text));
            let config = Config::load(&root);
            assert_eq!(config.layout(), Layout::default(), "{text}");
        }
        let root = vault("absent", None);
        assert_eq!(Config::load(&root).layout(), Layout::default());
    }

    #[test]
    fn language_folders_and_files_are_given_on_with_own_roles() {
        let root = vault(
            "layout",
            Some(
                r#"{"language":"de","folders":{"exams":"Prüfungen","vault-inbox":{"path":"In","description":"loose notes","color":"red"}},
                    "files":{"profile":"Me/Profile.md"}}"#,
            ),
        );
        let layout = layout(&root);
        assert_eq!(layout.language.as_deref(), Some("de"));
        assert_eq!(layout.folders["exams"].path, "Prüfungen");
        assert_eq!(layout.folders["exams"].description, None);
        assert_eq!(
            layout.folders["vault-inbox"].description.as_deref(),
            Some("loose notes")
        );
        assert_eq!(layout.files["profile"].path, "Me/Profile.md");
    }

    #[test]
    fn an_unknown_key_of_an_entry_is_kept_on_write() {
        let object: Value =
            serde_json::from_str(r#"{"path":"In","description":"loose","color":"red","order":3}"#)
                .unwrap();
        let entry = Entry::from_value(&object).unwrap();
        assert_eq!(entry.extra["color"], "red");
        assert_eq!(entry.to_value(), object);
        let short = Entry::from_value(&Value::String("In".into())).unwrap();
        assert_eq!(short.to_value(), Value::String("In".into()));
    }

    fn read_json(root: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(root.join(SOURCE)).unwrap()).unwrap()
    }

    fn keys(value: &Value) -> Vec<&str> {
        value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn setting_a_role_keeps_the_other_keys_and_their_order() {
        let root = vault(
            "set-order",
            Some(r#"{"language":"de","folders":{"inbox":"In"},"daily":{"folder":"D"},"zeta":1}"#),
        );
        set_folder_role(&root, "Prüfungen/", "exams", None).unwrap();
        set_folder_role(&root, "Wissen", "vault-notes", Some("loose notes")).unwrap();
        let json = read_json(&root);
        assert_eq!(
            keys(&json),
            ["language", "folders", "daily", "zeta", "schemaVersion"]
        );
        assert_eq!(keys(&json["folders"]), ["inbox", "exams", "vault-notes"]);
        assert_eq!(json["folders"]["exams"], "Prüfungen");
        assert_eq!(
            json["folders"]["vault-notes"],
            serde_json::json!({"path":"Wissen","description":"loose notes"})
        );
        assert_eq!(json["zeta"], 1);
    }

    #[test]
    fn a_role_is_created_in_a_vault_without_a_config() {
        let root = vault("set-new", None);
        let _ = fs::remove_dir_all(root.join(".nixe"));
        set_folder_role(&root, "Inbox", "inbox", None).unwrap();
        assert_eq!(
            read_json(&root),
            serde_json::json!({"folders":{"inbox":"Inbox"},"schemaVersion":1})
        );
    }

    #[test]
    fn a_folder_has_one_role_and_a_name_is_unique() {
        let root = vault("unique", Some(r#"{"folders":{"inbox":"In","exams":"Ex"}}"#));
        // The name is taken by another folder.
        assert!(set_folder_role(&root, "Other", "inbox", None).is_err());
        // The folder has a role: a second one is refused.
        assert!(set_folder_role(&root, "In", "archive", None).is_err());
        assert_eq!(keys(&read_json(&root)["folders"]), ["inbox", "exams"]);
        // The same role again updates its description and keeps unknown keys.
        fs::write(
            root.join(SOURCE),
            r#"{"folders":{"mine":{"path":"M","description":"a","color":"red"}}}"#,
        )
        .unwrap();
        set_folder_role(&root, "M", "mine", Some("b")).unwrap();
        assert_eq!(
            read_json(&root)["folders"]["mine"],
            serde_json::json!({"path":"M","description":"b","color":"red"})
        );
    }

    #[test]
    fn a_bad_role_is_refused_and_changes_nothing() {
        let text = r#"{"folders":{"inbox":"In"}}"#;
        let root = vault("refused", Some(text));
        for (path, role, desc) in [
            ("../Other", "inbox2", Some("x")),
            ("C:/Users", "inbox2", Some("x")),
            ("", "inbox2", Some("x")),
            ("Own", "own", None),
            ("Own", "own", Some("  ")),
            ("Own", "", Some("x")),
            ("Own", "a b", Some("x")),
        ] {
            assert!(
                set_folder_role(&root, path, role, desc).is_err(),
                "{path} {role}"
            );
        }
        assert_eq!(fs::read_to_string(root.join(SOURCE)).unwrap(), text);
    }

    #[test]
    fn an_invalid_or_newer_file_is_not_overwritten() {
        for text in ["{ not json", "[1]", r#"{"schemaVersion":2,"folders":{}}"#] {
            let root = vault("keep", Some(text));
            assert!(
                set_folder_role(&root, "A", "inbox", None).is_err(),
                "{text}"
            );
            assert!(remove_folder_role(&root, "A").is_err(), "{text}");
            assert_eq!(fs::read_to_string(root.join(SOURCE)).unwrap(), text);
        }
    }

    #[test]
    fn removing_a_role_keeps_the_rest() {
        let root = vault(
            "remove",
            Some(
                r#"{"language":"de","folders":{"inbox":"In","exams":"Ex"},"files":{"profile":"P.md"}}"#,
            ),
        );
        assert!(remove_folder_role(&root, "In/").unwrap());
        assert!(!remove_folder_role(&root, "In").unwrap());
        let json = read_json(&root);
        assert_eq!(keys(&json), ["language", "folders", "files"]);
        assert_eq!(keys(&json["folders"]), ["exams"]);
    }

    #[test]
    fn a_rename_updates_the_role_of_the_folder() {
        let root = vault(
            "rename",
            Some(
                r#"{"language":"de","folders":{"inbox":"In","exams":{"path":"Ex","description":"d","color":"red"}}}"#,
            ),
        );
        assert_eq!(rename_roles(&root, "In", "Eingang").unwrap(), 1);
        let json = read_json(&root);
        assert_eq!(keys(&json), ["language", "folders"]);
        assert_eq!(json["folders"]["inbox"], "Eingang");
        assert_eq!(json["folders"]["exams"]["path"], "Ex");
        // A folder with a longer name that only starts the same is not touched.
        assert_eq!(rename_roles(&root, "Ein", "X").unwrap(), 0);
    }

    #[test]
    fn a_move_of_a_parent_updates_every_role_below_it() {
        let root = vault(
            "parent",
            Some(
                r#"{"folders":{"projects":"Work","inbox":"Work/In","exams":"Workshop","archive":"Work/Old/2020"},"files":{"profile":"Work/Me.md"}}"#,
            ),
        );
        assert_eq!(rename_roles(&root, "Work", "Area/Work").unwrap(), 4);
        let json = read_json(&root);
        assert_eq!(json["folders"]["projects"], "Area/Work");
        assert_eq!(json["folders"]["inbox"], "Area/Work/In");
        assert_eq!(json["folders"]["exams"], "Workshop");
        assert_eq!(json["folders"]["archive"], "Area/Work/Old/2020");
        assert_eq!(json["files"]["profile"], "Area/Work/Me.md");
    }

    #[test]
    fn a_rename_without_roles_writes_nothing() {
        let root = vault("none", None);
        assert_eq!(rename_roles(&root, "A", "B").unwrap(), 0);
        assert!(!root.join(SOURCE).exists());
        let text = r#"{"folders":{"inbox":"In"}}"#;
        fs::write(root.join(SOURCE), text).unwrap();
        assert_eq!(rename_roles(&root, "A", "B").unwrap(), 0);
        assert_eq!(fs::read_to_string(root.join(SOURCE)).unwrap(), text);
    }

    #[test]
    fn a_folder_that_two_roles_share_gets_one_role_and_the_layout_marks_a_missing_folder() {
        let root = vault(
            "two",
            Some(r#"{"folders":{"inbox":"In","archive":"In","exams":"Gone"}}"#),
        );
        fs::create_dir_all(root.join("In")).unwrap();
        // A hand-written file with two roles on one folder: a third one is refused.
        assert!(set_folder_role(&root, "In", "projects", None).is_err());
        assert!(remove_folder_role(&root, "In").unwrap());
        let layout = layout(&root);
        assert_eq!(layout.folders.len(), 1);
        assert!(layout.folders["exams"].missing);
        fs::create_dir_all(root.join("Gone")).unwrap();
        assert!(!super::layout(&root).folders["exams"].missing);
    }
}
