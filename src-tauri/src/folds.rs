//! Fold state of the editor and the reading view (#110): which lines of which note are folded.
//! It lives in the app data directory, never in the vault.

use std::fs;
use std::io::Write;
use std::path::Path;

/// File name of the fold state inside the app data directory.
pub const FOLDS_FILE: &str = "folds.json";
/// Upper bound for the file; a few thousand notes with a few folds each stay far below it.
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// The fold state of `dir`; `None` when there is none yet.
pub fn read_folds(dir: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(dir.join(FOLDS_FILE)) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{FOLDS_FILE}: {e}")),
    }
}

/// Atomically replaces the fold state of `dir` (created when missing); refuses text that is no
/// JSON object, so a bug in the frontend cannot wipe it.
pub fn write_folds(dir: &Path, content: &str) -> Result<(), String> {
    if content.len() > MAX_BYTES {
        return Err("fold state too large".into());
    }
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(v) if v.is_object() => {}
        _ => return Err("fold state must be a JSON object".into()),
    }
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let target = dir.join(FOLDS_FILE);
    let tmp = dir.join(format!(".{FOLDS_FILE}.nixe-tmp"));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    fn tmp(name: &str) -> TestDir {
        TestDir::new(&format!("nixe-folds-{name}-"))
    }

    #[test]
    fn missing_file_reads_as_none() {
        let dir = tmp("missing");
        assert_eq!(read_folds(&dir), Ok(None));
    }

    #[test]
    fn written_state_reads_back_and_creates_the_directory() {
        let dir = tmp("roundtrip");
        write_folds(&dir, r#"{"/v/a.md":[3,9]}"#).unwrap();
        assert_eq!(
            read_folds(&dir).unwrap().as_deref(),
            Some(r#"{"/v/a.md":[3,9]}"#)
        );
        write_folds(&dir, "{}").unwrap();
        assert_eq!(read_folds(&dir).unwrap().as_deref(), Some("{}"));
        assert!(!dir.join(format!(".{FOLDS_FILE}.nixe-tmp")).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_text_that_is_no_object() {
        let dir = tmp("refuse");
        for bad in ["", "[1]", "null", "not json"] {
            assert!(write_folds(&dir, bad).is_err(), "{bad}");
        }
        assert!(!dir.join(FOLDS_FILE).exists());
    }

    #[test]
    fn refuses_oversized_state() {
        let dir = tmp("big");
        let big = format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_BYTES));
        assert!(write_folds(&dir, &big).is_err());
    }
}
