//! The import of the `.obsidian/` settings into `.nixe/` (ADR 0007, #441). When a vault has
//! `.obsidian/` and no `.nixe/config.json`, `.nixe/config.json` is written from `app.json`,
//! `templates.json` and `daily-notes.json`, and `.obsidian/bookmarks.json` is copied to
//! `.nixe/bookmarks.json` when that does not exist. It runs once: an existing
//! `.nixe/config.json` is never touched, `.obsidian/` is only read, and nothing is committed.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::config::SOURCE;

const BOOKMARKS: &str = ".nixe/bookmarks.json";

/// What the import did, for the notification.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct ImportReport {
    /// The files written into `.nixe/`.
    pub written: Vec<String>,
    /// The `.obsidian/` files the values came from.
    pub sources: Vec<String>,
    /// What went wrong; the app works on with the fallback.
    pub warnings: Vec<String>,
}

/// A JSON object of `.obsidian/<name>`; `None` when it is missing, with a warning when invalid.
fn read_object(root: &Path, name: &str, report: &mut ImportReport) -> Option<Map<String, Value>> {
    let rel = format!(".obsidian/{name}");
    let text = match fs::read_to_string(root.join(&rel)) {
        Ok(text) => text,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                report.warnings.push(format!("{rel}: {e}"));
            }
            return None;
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Some(object),
        Ok(_) => {
            report.warnings.push(format!("{rel} is not a JSON object"));
            None
        }
        Err(e) => {
            report.warnings.push(format!("{rel} is invalid JSON ({e})"));
            None
        }
    }
}

/// A folder or file value as a vault-relative path; `None` when it is empty, outside the vault or
/// relative to the note (`./`), which a role cannot say.
fn plain_path(object: &Map<String, Value>, key: &str) -> Option<String> {
    let raw = object.get(key)?.as_str()?.trim().replace('\\', "/");
    let path = raw.trim_matches('/');
    if path.is_empty()
        || raw.starts_with("./")
        || raw == "."
        || path.as_bytes().get(1) == Some(&b':')
        || path.split('/').any(|part| part == ".." || part == ".")
    {
        return None;
    }
    Some(path.to_string())
}

fn text(object: &Map<String, Value>, key: &str) -> Option<String> {
    let value = object.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn put(section: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        section.insert(key.into(), Value::String(value));
    }
}

/// Writes `content` to `target` as a file that does not exist yet (temp file, then rename).
fn write_new(root: &Path, rel: &str, content: &str) -> std::io::Result<()> {
    let target = root.join(rel);
    let dir = target.parent().unwrap_or(root);
    fs::create_dir_all(dir)?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = dir.join(format!(".{name}.nixe-tmp"));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        if target.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "exists",
            ));
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Imports the `.obsidian/` settings of the vault `root`; see the module comment.
pub fn import_obsidian(root: &Path) -> ImportReport {
    let mut report = ImportReport::default();
    if !root.join(".obsidian").is_dir() || root.join(SOURCE).exists() {
        return report;
    }

    let app = read_object(root, "app.json", &mut report);
    let templates = read_object(root, "templates.json", &mut report);
    let daily = read_object(root, "daily-notes.json", &mut report);

    let mut config = Map::new();
    let mut folders = Map::new();
    let mut from = Vec::new();

    if let Some(app) = &app {
        let before = folders.len();
        if let Some(path) = plain_path(app, "attachmentFolderPath") {
            folders.insert("attachments".into(), Value::String(path));
        }
        // The folder only applies when Obsidian is set to "folder".
        if text(app, "newFileLocation").as_deref() == Some("folder") {
            if let Some(path) = plain_path(app, "newFileFolderPath") {
                folders.insert("inbox".into(), Value::String(path));
            }
        }
        if folders.len() > before {
            from.push("app.json");
        }
    }
    if let Some(templates) = &templates {
        let mut section = Map::new();
        if let Some(path) = plain_path(templates, "folder") {
            folders.insert("templates".into(), Value::String(path));
            from.push("templates.json");
        }
        put(&mut section, "dateFormat", text(templates, "dateFormat"));
        put(&mut section, "timeFormat", text(templates, "timeFormat"));
        if !section.is_empty() {
            if !from.contains(&"templates.json") {
                from.push("templates.json");
            }
            config.insert("templates".into(), Value::Object(section));
        }
    }
    if let Some(daily) = &daily {
        let mut section = Map::new();
        put(&mut section, "format", text(daily, "format"));
        put(&mut section, "template", plain_path(daily, "template"));
        if let Some(path) = plain_path(daily, "folder") {
            folders.insert("journal".into(), Value::String(path));
        }
        if !section.is_empty() || folders.contains_key("journal") {
            from.push("daily-notes.json");
        }
        if !section.is_empty() {
            config.insert("daily".into(), Value::Object(section));
        }
    }

    if !folders.is_empty() || config.contains_key("templates") || config.contains_key("daily") {
        let mut out = Map::new();
        out.insert("schemaVersion".into(), json!(1));
        if !folders.is_empty() {
            out.insert("folders".into(), Value::Object(folders));
        }
        out.extend(config);
        let content = serde_json::to_string_pretty(&Value::Object(out)).unwrap_or_default() + "\n";
        match write_new(root, SOURCE, &content) {
            Ok(()) => {
                report.written.push(SOURCE.into());
                report
                    .sources
                    .extend(from.iter().map(|name| format!(".obsidian/{name}")));
            }
            Err(e) => report
                .warnings
                .push(format!("{SOURCE} was not written: {e}")),
        }
    }

    import_bookmarks(root, &mut report);
    if !report.written.is_empty() {
        log::info!(
            "imported {} from {:?}",
            report.written.join(", "),
            report.sources
        );
    }
    for warning in &report.warnings {
        log::warn!("import of .obsidian: {warning}");
    }
    report
}

fn import_bookmarks(root: &Path, report: &mut ImportReport) {
    let source = ".obsidian/bookmarks.json";
    if root.join(BOOKMARKS).exists() {
        return;
    }
    let content = match fs::read_to_string(root.join(source)) {
        Ok(content) => content,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                report.warnings.push(format!("{source}: {e}"));
            }
            return;
        }
    };
    if let Err(e) = serde_json::from_str::<Value>(&content) {
        report
            .warnings
            .push(format!("{source} is invalid JSON ({e})"));
        return;
    }
    match write_new(root, BOOKMARKS, &content) {
        Ok(()) => {
            report.written.push(BOOKMARKS.into());
            report.sources.push(source.into());
        }
        Err(e) => report
            .warnings
            .push(format!("{BOOKMARKS} was not written: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    fn vault(name: &str) -> TestDir {
        let root = TestDir::new(&format!("nixe-import-{name}-"));
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        root
    }

    fn obsidian(root: &Path, name: &str, content: &str) {
        fs::write(root.join(".obsidian").join(name), content).unwrap();
    }

    fn config(root: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(root.join(SOURCE)).unwrap()).unwrap()
    }

    const APP: &str = r#"{"newFileLocation":"folder","newFileFolderPath":"/Inbox/","attachmentFolderPath":"Assets"}"#;

    #[test]
    fn imports_every_file_as_roles() {
        let root = vault("all");
        obsidian(&root, "app.json", APP);
        obsidian(
            &root,
            "templates.json",
            r#"{"folder":"Templates","dateFormat":"YYYY"}"#,
        );
        obsidian(
            &root,
            "daily-notes.json",
            r#"{"folder":"Journal","format":"YYYY-MM-DD","template":"Templates/Daily"}"#,
        );
        obsidian(&root, "bookmarks.json", r#"{"items":[]}"#);
        let report = import_obsidian(&root);
        assert_eq!(report.written, [SOURCE, BOOKMARKS]);
        assert_eq!(
            report.sources,
            [
                ".obsidian/app.json",
                ".obsidian/templates.json",
                ".obsidian/daily-notes.json",
                ".obsidian/bookmarks.json"
            ]
        );
        assert!(report.warnings.is_empty());
        assert_eq!(
            config(&root),
            json!({
                "schemaVersion": 1,
                "folders": {
                    "attachments": "Assets",
                    "inbox": "Inbox",
                    "templates": "Templates",
                    "journal": "Journal"
                },
                "templates": {"dateFormat": "YYYY"},
                "daily": {"format": "YYYY-MM-DD", "template": "Templates/Daily"}
            })
        );
        assert_eq!(
            fs::read_to_string(root.join(BOOKMARKS)).unwrap(),
            r#"{"items":[]}"#
        );
        assert!(!root.join(".nixe/.config.json.nixe-tmp").exists());
    }

    #[test]
    fn the_imported_config_is_read_back_by_the_reader() {
        let root = vault("readback");
        obsidian(&root, "app.json", APP);
        obsidian(
            &root,
            "daily-notes.json",
            r#"{"folder":"Journal","format":"YYYY"}"#,
        );
        import_obsidian(&root);
        let config = super::super::config::Config::load(&root);
        assert_eq!(config.new_note_folder().as_deref(), Some("Inbox"));
        assert_eq!(config.attachment_folder().as_deref(), Some("Assets"));
        assert_eq!(config.daily_folder().as_deref(), Some("Journal"));
        assert_eq!(config.daily_format().as_deref(), Some("YYYY"));
    }

    #[test]
    fn only_the_files_that_are_present_are_imported() {
        let root = vault("some");
        obsidian(&root, "templates.json", r#"{"folder":"Templates"}"#);
        let report = import_obsidian(&root);
        assert_eq!(report.written, [SOURCE]);
        assert_eq!(report.sources, [".obsidian/templates.json"]);
        assert_eq!(
            config(&root),
            json!({"schemaVersion": 1, "folders": {"templates": "Templates"}})
        );
        assert!(!root.join(BOOKMARKS).exists());
    }

    #[test]
    fn only_the_bookmarks_are_copied_without_settings() {
        let root = vault("bookmarks");
        obsidian(&root, "bookmarks.json", r#"{"items":[]}"#);
        let report = import_obsidian(&root);
        assert_eq!(report.written, [BOOKMARKS]);
        assert!(!root.join(SOURCE).exists());
    }

    #[test]
    fn nothing_to_import_writes_nothing() {
        let root = vault("none");
        obsidian(
            &root,
            "app.json",
            r#"{"newFileLocation":"current","attachmentFolderPath":"./"}"#,
        );
        assert_eq!(import_obsidian(&root), ImportReport::default());
        assert!(!root.join(".nixe").exists());
    }

    #[test]
    fn a_vault_without_obsidian_is_left_alone() {
        let root = vault("noobsidian");
        fs::remove_dir_all(root.join(".obsidian")).unwrap();
        assert_eq!(import_obsidian(&root), ImportReport::default());
        assert!(!root.join(".nixe").exists());
    }

    #[test]
    fn an_existing_config_is_never_overwritten_or_completed() {
        let root = vault("existing");
        obsidian(&root, "app.json", APP);
        obsidian(&root, "bookmarks.json", r#"{"items":[]}"#);
        fs::create_dir_all(root.join(".nixe")).unwrap();
        fs::write(root.join(SOURCE), r#"{"language":"de"}"#).unwrap();
        let report = import_obsidian(&root);
        assert_eq!(report, ImportReport::default());
        assert_eq!(
            fs::read_to_string(root.join(SOURCE)).unwrap(),
            r#"{"language":"de"}"#
        );
        assert!(!root.join(BOOKMARKS).exists());
    }

    #[test]
    fn existing_bookmarks_are_kept() {
        let root = vault("keepbookmarks");
        obsidian(&root, "templates.json", r#"{"folder":"T"}"#);
        obsidian(&root, "bookmarks.json", r#"{"items":[]}"#);
        fs::create_dir_all(root.join(".nixe")).unwrap();
        fs::write(root.join(BOOKMARKS), "mine").unwrap();
        let report = import_obsidian(&root);
        assert_eq!(report.written, [SOURCE]);
        assert_eq!(fs::read_to_string(root.join(BOOKMARKS)).unwrap(), "mine");
    }

    #[test]
    fn an_invalid_source_is_a_warning_and_the_others_are_imported() {
        let root = vault("invalid");
        obsidian(&root, "app.json", "{nope");
        obsidian(&root, "templates.json", r#"{"folder":"Templates"}"#);
        obsidian(&root, "bookmarks.json", "[[");
        let report = import_obsidian(&root);
        assert_eq!(report.written, [SOURCE]);
        assert_eq!(report.warnings.len(), 2);
        assert!(report.warnings[0].contains("app.json"));
        assert!(report.warnings[1].contains("bookmarks.json"));
        assert!(!root.join(BOOKMARKS).exists());
    }

    #[test]
    fn obsidian_is_never_changed() {
        let root = vault("readonly-source");
        obsidian(&root, "app.json", APP);
        let before = fs::read_to_string(root.join(".obsidian/app.json")).unwrap();
        import_obsidian(&root);
        assert_eq!(
            fs::read_to_string(root.join(".obsidian/app.json")).unwrap(),
            before
        );
        let mut names: Vec<_> = fs::read_dir(root.join(".obsidian"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        names.sort();
        assert_eq!(names, ["app.json"]);
    }

    #[test]
    fn a_folder_outside_the_vault_or_relative_to_the_note_is_not_imported() {
        let root = vault("outside");
        obsidian(
            &root,
            "app.json",
            r#"{"attachmentFolderPath":"./files","newFileLocation":"folder","newFileFolderPath":"../Out"}"#,
        );
        obsidian(&root, "templates.json", r#"{"folder":"C:/Templates"}"#);
        assert_eq!(import_obsidian(&root), ImportReport::default());
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_vault_is_a_warning_and_writes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let root = vault("readonly");
        obsidian(&root, "templates.json", r#"{"folder":"Templates"}"#);
        let mode = fs::metadata(&root).unwrap().permissions();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        // Running as root ignores the mode; the check only holds where it applies.
        let enforced = fs::create_dir(root.join("probe")).is_err();
        let report = import_obsidian(&root);
        fs::set_permissions(&root, mode).unwrap();
        if enforced {
            assert!(report.written.is_empty());
            assert_eq!(report.warnings.len(), 1);
            assert!(report.warnings[0].contains(SOURCE));
            assert!(!root.join(".nixe").exists());
        }
    }
}
