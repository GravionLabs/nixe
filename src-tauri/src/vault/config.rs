//! The vault configuration `.nixe/config.json` (ADR 0007, #439): `language`, `folders`, `files`
//! and the sections `newNotes`, `templates` and `daily`. It is read per key; a key it does not
//! set comes from `.obsidian/` (until the expiry of the fallback). Nothing here writes.

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
}

impl Entry {
    fn from_value(value: &Value) -> Option<Entry> {
        match value {
            Value::String(path) => Some(Entry {
                path: path.clone(),
                description: None,
                extra: Map::new(),
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
                })
            }
            _ => None,
        }
    }

    /// The JSON form for a write (no writer yet, a later item of #435): the short form when the entry is only a path.
    #[allow(dead_code)]
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

/// The layout of the open vault for the frontend.
pub fn layout(root: &Path) -> Layout {
    Config::load(root).layout()
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
}
