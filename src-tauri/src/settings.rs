//! Settings page (#99): the app settings file in the app config directory, and the Obsidian
//! settings of a vault that the page shows read-only with their source.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;

use crate::fileops;
use crate::vault::relink::{self, LinkFormat};

/// File name of the app settings inside the app config directory.
pub const SETTINGS_FILE: &str = "settings.json";
/// Upper bound for the settings file; the recent vaults and their layouts stay far below it.
const MAX_BYTES: usize = 1024 * 1024;

/// The settings file of `dir`; `None` when there is none yet.
pub fn read_settings(dir: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(dir.join(SETTINGS_FILE)) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", SETTINGS_FILE)),
    }
}

/// Atomically replaces the settings file of `dir` (created when missing); refuses text that is no
/// JSON object, so a bug in the frontend cannot wipe the settings.
pub fn write_settings(dir: &Path, content: &str) -> Result<(), String> {
    if content.len() > MAX_BYTES {
        return Err("settings too large".into());
    }
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(v) if v.is_object() => {}
        _ => return Err("settings must be a JSON object".into()),
    }
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let target = dir.join(SETTINGS_FILE);
    let tmp = dir.join(format!(".{SETTINGS_FILE}.nixe-tmp"));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, &target)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {e}", target.display())
    })
}

/// One Obsidian setting as the page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ObsidianSetting {
    pub id: String,
    pub label: String,
    /// The value in effect; `None` when the file does not set it.
    pub value: Option<String>,
    /// The file it is read from, vault-relative.
    pub source: String,
}

fn entry(id: &str, label: &str, value: Option<String>, source: &str) -> ObsidianSetting {
    ObsidianSetting {
        id: id.into(),
        label: label.into(),
        value,
        source: source.into(),
    }
}

/// The raw string value of `key` in `.obsidian/<file>`, trimmed; `None` when missing or empty.
fn raw(root: &Path, file: &str, key: &str) -> Option<String> {
    let text = fs::read_to_string(root.join(".obsidian").join(file)).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let value = json.get(key)?.as_str()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// The settings of the vault that Obsidian also has: new-note folder, attachment folder, link
/// format, templates and daily notes.
pub fn obsidian_settings(root: &Path) -> Vec<ObsidianSetting> {
    let app = ".obsidian/app.json";
    let location = fileops::new_note_location(root);
    let new_note = match location.location.as_str() {
        "folder" => format!("Folder: {}", location.folder),
        "current" => "Same folder as the current note".to_string(),
        _ => "Vault root".to_string(),
    };
    let link_format = match relink::link_format(root) {
        LinkFormat::Shortest => "Shortest path when possible",
        LinkFormat::Relative => "Relative path to the note",
        LinkFormat::Absolute => "Absolute path in the vault",
    };
    let daily = fileops::daily_notes_config(root);
    let daily_source = ".obsidian/daily-notes.json";
    vec![
        entry(
            "new-note-location",
            "Default location for new notes",
            Some(new_note),
            app,
        ),
        entry(
            "attachment-folder",
            "Attachment folder",
            raw(root, "app.json", "attachmentFolderPath"),
            app,
        ),
        entry(
            "link-format",
            "New link format",
            Some(link_format.to_string()),
            app,
        ),
        entry(
            "template-folder",
            "Template folder",
            fileops::template_folder(root),
            ".obsidian/templates.json",
        ),
        entry(
            "daily-folder",
            "Daily notes folder",
            daily.folder,
            daily_source,
        ),
        entry(
            "daily-format",
            "Daily notes date format",
            daily.format,
            daily_source,
        ),
        entry(
            "daily-template",
            "Daily notes template",
            daily.template,
            daily_source,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-settings-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn value<'a>(list: &'a [ObsidianSetting], id: &str) -> &'a ObsidianSetting {
        list.iter().find(|s| s.id == id).unwrap()
    }

    #[test]
    fn a_missing_settings_file_reads_as_none() {
        let dir = tmp("missing");
        assert_eq!(read_settings(&dir).unwrap(), None);
        assert_eq!(read_settings(&dir.join("nope")).unwrap(), None);
    }

    #[test]
    fn settings_are_written_and_read_back() {
        let dir = tmp("roundtrip").join("config");
        write_settings(&dir, r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(
            read_settings(&dir).unwrap().as_deref(),
            Some(r#"{"theme":"dark"}"#)
        );
        write_settings(&dir, r#"{"theme":"light"}"#).unwrap();
        assert_eq!(
            read_settings(&dir).unwrap().as_deref(),
            Some(r#"{"theme":"light"}"#)
        );
        let names: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(names.len(), 1, "no temp file is left behind");
    }

    #[test]
    fn text_that_is_no_json_object_is_refused() {
        let dir = tmp("refuse");
        write_settings(&dir, r#"{"a":1}"#).unwrap();
        for bad in ["", "not json", "[1]", "null"] {
            assert!(write_settings(&dir, bad).is_err(), "{bad}");
        }
        assert_eq!(read_settings(&dir).unwrap().as_deref(), Some(r#"{"a":1}"#));
    }

    #[test]
    fn a_vault_without_obsidian_files_shows_the_defaults() {
        let root = tmp("plain");
        let list = obsidian_settings(&root);
        assert_eq!(
            value(&list, "new-note-location").value.as_deref(),
            Some("Vault root")
        );
        assert_eq!(
            value(&list, "link-format").value.as_deref(),
            Some("Shortest path when possible")
        );
        assert_eq!(value(&list, "attachment-folder").value, None);
        assert_eq!(value(&list, "template-folder").value, None);
        assert_eq!(value(&list, "daily-folder").value, None);
    }

    #[test]
    fn values_and_sources_come_from_the_obsidian_files() {
        let root = tmp("vault");
        let obsidian = root.join(".obsidian");
        fs::create_dir_all(&obsidian).unwrap();
        fs::write(
            obsidian.join("app.json"),
            r#"{"newFileLocation":"folder","newFileFolderPath":"Inbox","attachmentFolderPath":"Assets","newLinkFormat":"relative"}"#,
        )
        .unwrap();
        fs::write(obsidian.join("templates.json"), r#"{"folder":"Templates"}"#).unwrap();
        fs::write(
            obsidian.join("daily-notes.json"),
            r#"{"folder":"Daily","format":"YYYY-MM-DD","template":"Templates/Daily"}"#,
        )
        .unwrap();
        let list = obsidian_settings(&root);
        assert_eq!(
            value(&list, "new-note-location").value.as_deref(),
            Some("Folder: Inbox")
        );
        assert_eq!(
            value(&list, "new-note-location").source,
            ".obsidian/app.json"
        );
        assert_eq!(
            value(&list, "attachment-folder").value.as_deref(),
            Some("Assets")
        );
        assert_eq!(
            value(&list, "link-format").value.as_deref(),
            Some("Relative path to the note")
        );
        assert_eq!(
            value(&list, "template-folder").value.as_deref(),
            Some("Templates")
        );
        assert_eq!(
            value(&list, "template-folder").source,
            ".obsidian/templates.json"
        );
        assert_eq!(
            value(&list, "daily-format").value.as_deref(),
            Some("YYYY-MM-DD")
        );
        assert_eq!(
            value(&list, "daily-template").source,
            ".obsidian/daily-notes.json"
        );
    }
}
