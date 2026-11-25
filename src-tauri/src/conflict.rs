//! Sync conflicts (#76): a note that both sides changed keeps both versions. The remote
//! version stays in `Note.md`, the local one goes to `Note (conflict <date> <device>).md`.
//! The pair is resolved by keeping one text; the copy then goes to `.trash/`.

use std::fs;
use std::path::{Path, PathBuf};

use crate::fileops;

const MARK: &str = " (conflict ";

/// `Note.md` -> `Note (conflict 2026-11-16 mac).md`. The extension stays last.
pub fn copy_name(file_name: &str, date: &str, device: &str) -> String {
    let (stem, ext) = split_ext(file_name);
    format!("{stem}{MARK}{date} {device}){ext}")
}

fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.').filter(|i| *i > 0) {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    }
}

/// The name of the original when `file_name` is a conflict copy.
pub fn original_name(file_name: &str) -> Option<String> {
    let (stem, ext) = split_ext(file_name);
    let start = stem.rfind(MARK)?;
    let tail = stem[start + MARK.len()..].strip_suffix(')')?;
    let (date, device) = tail.split_once(' ')?;
    let b = date.as_bytes();
    let date_ok = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        });
    if !date_ok || device.is_empty() || start == 0 {
        return None;
    }
    Some(format!("{}{ext}", &stem[..start]))
}

/// Today's date (UTC) as `YYYY-MM-DD`.
pub fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    civil_date(secs.div_euclid(86_400))
}

/// Days since 1970-01-01 as `YYYY-MM-DD` (proleptic Gregorian).
pub fn civil_date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// A short name for this device that is safe in a file name.
pub fn device_name() -> String {
    let raw = ["HOSTNAME", "COMPUTERNAME", "HOST"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
        })
        .unwrap_or_default();
    sanitize_device(&raw)
}

pub fn sanitize_device(raw: &str) -> String {
    let name: String = raw
        .trim()
        .split('.')
        .next()
        .unwrap_or("")
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if name.is_empty() {
        "device".into()
    } else {
        name
    }
}

/// The two paths of a conflict.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Pair {
    pub original: String,
    pub copy: String,
}

fn to_s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The pair `path` belongs to (as the original or as the copy), if the other half exists.
pub fn find_pair(path: &Path) -> Option<Pair> {
    let name = path.file_name()?.to_str()?;
    let dir = path.parent()?;
    if let Some(original) = original_name(name) {
        let original = dir.join(original);
        return original.is_file().then(|| Pair {
            original: to_s(&original),
            copy: to_s(path),
        });
    }
    let mut copies: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .and_then(original_name)
                .is_some_and(|o| o == name)
        })
        .map(|e| e.path())
        .collect();
    copies.sort();
    let copy = copies.into_iter().next()?;
    Some(Pair {
        original: to_s(path),
        copy: to_s(&copy),
    })
}

/// Which text of the open file wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Keep {
    /// The file that is open.
    This,
    /// The other half of the pair.
    Other,
}

/// Replaces the original with the chosen text and moves the copy to `.trash/`.
/// Returns the path of the original.
pub fn resolve(root: &Path, path: &Path, keep: Keep) -> Result<PathBuf, String> {
    fileops::confined(root, path)?;
    let pair = find_pair(path).ok_or_else(|| format!("no conflict pair for {}", path.display()))?;
    let (original, copy) = (PathBuf::from(&pair.original), PathBuf::from(&pair.copy));
    let open_is_copy = path == copy;
    let chosen_is_copy = open_is_copy == (keep == Keep::This);
    if chosen_is_copy {
        fs::copy(&copy, &original).map_err(|e| format!("{}: {e}", original.display()))?;
    }
    fileops::trash_path(root, &copy)?;
    Ok(original)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;

    fn tmp(name: &str) -> TestDir {
        TestDir::new(&format!("nixe-conflict-{name}-"))
    }

    #[test]
    fn copy_names_round_trip() {
        let n = copy_name("Note.md", "2026-11-16", "mac");
        assert_eq!(n, "Note (conflict 2026-11-16 mac).md");
        assert_eq!(original_name(&n).as_deref(), Some("Note.md"));
        let n = copy_name("img.tar.gz", "2026-01-02", "pc");
        assert_eq!(original_name(&n).as_deref(), Some("img.tar.gz"));
        let n = copy_name("README", "2026-01-02", "pc");
        assert_eq!(original_name(&n).as_deref(), Some("README"));
    }

    #[test]
    fn ordinary_names_are_no_copies() {
        for n in [
            "Note.md",
            "Note (conflict).md",
            "Note (conflict 2026-1-1 x).md",
            "Note (conflict 2026-11-16 ).md",
            " (conflict 2026-11-16 mac).md",
        ] {
            assert_eq!(original_name(n), None, "{n}");
        }
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(20_773), "2026-11-16");
        assert_eq!(civil_date(19_782), "2024-02-29");
        assert_eq!(today().len(), 10);
    }

    #[test]
    fn device_names_are_file_safe() {
        assert_eq!(sanitize_device("Jerome's Mac.local\n"), "Jerome-s-Mac");
        assert_eq!(sanitize_device(""), "device");
        assert!(!device_name().is_empty());
    }

    #[test]
    fn pair_is_found_from_both_halves() {
        let root = tmp("pair");
        fs::create_dir_all(root.join("d")).unwrap();
        let o = root.join("d/Note.md");
        let c = root.join("d/Note (conflict 2026-11-16 mac).md");
        fs::write(&o, "remote").unwrap();
        assert_eq!(find_pair(&o), None);
        fs::write(&c, "local").unwrap();
        let pair = Pair {
            original: to_s(&o),
            copy: to_s(&c),
        };
        assert_eq!(find_pair(&o), Some(pair.clone()));
        assert_eq!(find_pair(&c), Some(pair));
    }

    fn setup(name: &str) -> (TestDir, PathBuf, PathBuf) {
        let root = tmp(name);
        let o = root.join("Note.md");
        let c = root.join("Note (conflict 2026-11-16 mac).md");
        fs::write(&o, "remote").unwrap();
        fs::write(&c, "local").unwrap();
        (root, o, c)
    }

    #[test]
    fn keep_this_on_the_original_keeps_the_remote_text() {
        let (root, o, c) = setup("keep-orig");
        assert_eq!(resolve(&root, &o, Keep::This).unwrap(), o);
        assert_eq!(fs::read_to_string(&o).unwrap(), "remote");
        assert!(!c.exists());
        assert_eq!(
            fs::read_to_string(root.join(".trash/Note (conflict 2026-11-16 mac).md")).unwrap(),
            "local"
        );
    }

    #[test]
    fn keep_other_on_the_original_takes_the_copy_text() {
        let (root, o, c) = setup("other-orig");
        resolve(&root, &o, Keep::Other).unwrap();
        assert_eq!(fs::read_to_string(&o).unwrap(), "local");
        assert!(!c.exists());
    }

    #[test]
    fn keep_this_on_the_copy_replaces_the_original() {
        let (root, o, c) = setup("keep-copy");
        assert_eq!(resolve(&root, &c, Keep::This).unwrap(), o);
        assert_eq!(fs::read_to_string(&o).unwrap(), "local");
        assert!(!c.exists());
    }

    #[test]
    fn keep_other_on_the_copy_keeps_the_original() {
        let (root, o, c) = setup("other-copy");
        resolve(&root, &c, Keep::Other).unwrap();
        assert_eq!(fs::read_to_string(&o).unwrap(), "remote");
        assert!(!c.exists());
    }

    #[test]
    fn binary_text_is_copied_byte_for_byte() {
        let root = tmp("bin");
        let o = root.join("a.png");
        let c = root.join("a (conflict 2026-11-16 mac).png");
        fs::write(&o, [0u8, 1, 2]).unwrap();
        fs::write(&c, [255u8, 0, 254]).unwrap();
        resolve(&root, &o, Keep::Other).unwrap();
        assert_eq!(fs::read(&o).unwrap(), vec![255u8, 0, 254]);
    }

    #[test]
    fn a_file_without_a_pair_or_outside_the_vault_is_refused() {
        let root = tmp("none");
        fs::write(root.join("Note.md"), "x").unwrap();
        assert!(resolve(&root, &root.join("Note.md"), Keep::This).is_err());
        let other = tmp("none-other");
        fs::write(other.join("a.md"), "x").unwrap();
        fs::write(other.join("a (conflict 2026-11-16 mac).md"), "y").unwrap();
        assert!(resolve(&root, &other.join("a.md"), Keep::This).is_err());
        assert!(other.join("a.md").exists());
    }
}
