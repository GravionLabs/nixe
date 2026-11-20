//! `nixe daily` (#80): the daily note of today, from `.obsidian/daily-notes.json` (folder, date
//! format, template). The date format is Moment.js, as in `src/app/core/templates/template-core.ts`.

use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, FixedOffset, Timelike};

use crate::cli::CliError;
use crate::cli_write::{appended, open_in_viewer};
use crate::{fileops, write};

const DEFAULT_FORMAT: &str = "YYYY-MM-DD";
const DEFAULT_TIME_FORMAT: &str = "HH:mm";

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const DAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// Moment tokens, longest first so that `YYYY` wins over `YY`.
const TOKENS: [&str; 40] = [
    "YYYY", "DDDD", "MMMM", "dddd", "SSS", "YY", "MMM", "DDD", "ddd", "Mo", "MM", "Do", "DD", "dd",
    "WW", "HH", "hh", "kk", "mm", "ss", "SS", "ZZ", "Q", "M", "D", "d", "E", "W", "H", "h", "k",
    "m", "s", "S", "A", "a", "Z", "X", "x", "[",
];

fn ordinal(n: u32) -> String {
    let suffix = match (n % 100, n % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

fn offset(d: &DateTime<FixedOffset>, colon: bool) -> String {
    let minutes = d.offset().local_minus_utc() / 60;
    let sign = if minutes >= 0 { '+' } else { '-' };
    let (h, m) = (minutes.abs() / 60, minutes.abs() % 60);
    if colon {
        format!("{sign}{h:02}:{m:02}")
    } else {
        format!("{sign}{h:02}{m:02}")
    }
}

fn token(t: &str, d: &DateTime<FixedOffset>) -> String {
    let hour = d.hour();
    let weekday = d.weekday();
    let day_name = DAYS[weekday.num_days_from_sunday() as usize];
    let month_name = MONTHS[d.month0() as usize];
    let ms = d.timestamp_subsec_millis();
    match t {
        "YYYY" => format!("{:04}", d.year()),
        "YY" => format!("{:02}", d.year().rem_euclid(100)),
        "Q" => (d.month0() / 3 + 1).to_string(),
        "MMMM" => month_name.to_string(),
        "MMM" => month_name[..3].to_string(),
        "MM" => format!("{:02}", d.month()),
        "Mo" => ordinal(d.month()),
        "M" => d.month().to_string(),
        "DDDD" => format!("{:03}", d.ordinal()),
        "DDD" => d.ordinal().to_string(),
        "DD" => format!("{:02}", d.day()),
        "Do" => ordinal(d.day()),
        "D" => d.day().to_string(),
        "dddd" => day_name.to_string(),
        "ddd" => day_name[..3].to_string(),
        "dd" => day_name[..2].to_string(),
        "d" => weekday.num_days_from_sunday().to_string(),
        "E" => weekday.number_from_monday().to_string(),
        "WW" => format!("{:02}", d.iso_week().week()),
        "W" => d.iso_week().week().to_string(),
        "HH" => format!("{hour:02}"),
        "H" => hour.to_string(),
        "hh" => format!("{:02}", if hour % 12 == 0 { 12 } else { hour % 12 }),
        "h" => (if hour % 12 == 0 { 12 } else { hour % 12 }).to_string(),
        "kk" => format!("{:02}", if hour == 0 { 24 } else { hour }),
        "k" => (if hour == 0 { 24 } else { hour }).to_string(),
        "mm" => format!("{:02}", d.minute()),
        "m" => d.minute().to_string(),
        "ss" => format!("{:02}", d.second()),
        "s" => d.second().to_string(),
        "SSS" => format!("{ms:03}"),
        "SS" => format!("{:02}", ms / 10),
        "S" => (ms / 100).to_string(),
        "A" => (if hour < 12 { "AM" } else { "PM" }).to_string(),
        "a" => (if hour < 12 { "am" } else { "pm" }).to_string(),
        "ZZ" => offset(d, false),
        "Z" => offset(d, true),
        "X" => d.timestamp().to_string(),
        "x" => d.timestamp_millis().to_string(),
        _ => t.to_string(),
    }
}

/// Formats a date with Moment.js tokens (English); text in `[brackets]` stays as it is.
pub fn format_moment(date: &DateTime<FixedOffset>, format: &str) -> String {
    let mut out = String::new();
    let mut rest = format;
    while !rest.is_empty() {
        let Some(t) = TOKENS.iter().find(|t| rest.starts_with(**t)) else {
            let c = rest.chars().next().unwrap();
            out.push(c);
            rest = &rest[c.len_utf8()..];
            continue;
        };
        if *t == "[" {
            match rest.find(']') {
                Some(end) => {
                    out.push_str(&rest[1..end]);
                    rest = &rest[end + 1..];
                }
                None => {
                    out.push('[');
                    rest = &rest[1..];
                }
            }
        } else {
            out.push_str(&token(t, date));
            rest = &rest[t.len()..];
        }
    }
    out
}

/// Replaces `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}` and `{{time:FORMAT}}`; other
/// `{{…}}` text stays.
pub fn expand_template(text: &str, title: &str, now: &DateTime<FixedOffset>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        let (name, format) = match inner.split_once(':') {
            Some((n, f)) => (n.trim(), Some(f.trim())),
            None => (inner.trim(), None),
        };
        let replacement = match name {
            "title" if format.is_none() => Some(title.to_string()),
            "date" | "time" => {
                let fallback = if name == "date" {
                    DEFAULT_FORMAT
                } else {
                    DEFAULT_TIME_FORMAT
                };
                Some(format_moment(
                    now,
                    format.filter(|f| !f.is_empty()).unwrap_or(fallback),
                ))
            }
            _ => None,
        };
        match replacement {
            Some(r) => out.push_str(&r),
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// The vault-relative path of the daily note of `now`; refuses a path outside the vault.
pub fn daily_path(
    config: &fileops::DailyNotesConfig,
    now: &DateTime<FixedOffset>,
) -> Result<String, CliError> {
    let name = format_moment(now, config.format.as_deref().unwrap_or(DEFAULT_FORMAT));
    let rel = match &config.folder {
        Some(folder) => format!("{folder}/{name}"),
        None => name,
    };
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_matches('/');
    if rel.is_empty()
        || rel.contains(':')
        || rel
            .split('/')
            .any(|c| c.is_empty() || c == "." || c == "..")
    {
        return Err(CliError::Failed(format!("{rel}: not a path in the vault")));
    }
    Ok(format!("{rel}.md"))
}

fn failed(e: impl ToString) -> CliError {
    CliError::Failed(e.to_string())
}

/// Creates the daily note of `now` from its template when it does not exist; returns its path.
fn ensure(root: &Path, now: &DateTime<FixedOffset>) -> Result<PathBuf, CliError> {
    ensure_with(root, &fileops::daily_notes_config(root), now)
}

/// Like `ensure`, with the daily notes settings given (the capture window merges the app settings).
pub(crate) fn ensure_with(
    root: &Path,
    config: &fileops::DailyNotesConfig,
    now: &DateTime<FixedOffset>,
) -> Result<PathBuf, CliError> {
    let rel = daily_path(config, now)?;
    let target = root.join(&rel);
    if target.is_file() {
        return Ok(target);
    }
    let template = match &config.template {
        Some(t) => {
            let t = if t.to_lowercase().ends_with(".md") {
                t.clone()
            } else {
                format!("{t}.md")
            };
            let file = root.join(&t);
            std::fs::read_to_string(&file)
                .map_err(|e| CliError::Failed(format!("template {t}: {e}")))?
        }
        None => String::new(),
    };
    let title = Path::new(&rel)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(dir) = target.parent() {
        fileops::create_dir(root, dir).map_err(failed)?;
    }
    let write_root = write::write_root(Some(root), None, &target).map_err(failed)?;
    write::write_text_file(
        &write_root,
        &target,
        &expand_template(&template, &title, now),
    )
    .map_err(failed)?;
    Ok(target)
}

/// `nixe daily [--append text]`: prints the path of today's daily note. With text it is appended
/// (the note is created from its template first); without, the note opens in the viewer.
pub fn run(
    root: &Path,
    append: Option<&str>,
    now: DateTime<FixedOffset>,
    out: &mut dyn Write,
) -> Result<(), CliError> {
    let target = ensure(root, &now)?;
    if let Some(text) = append {
        if text.is_empty() {
            return Err(CliError::Usage("nothing to append".into()));
        }
        let existing = std::fs::read_to_string(&target)
            .map_err(|e| CliError::Failed(format!("{}: {e}", target.display())))?;
        let write_root = write::write_root(Some(root), None, &target).map_err(failed)?;
        write::write_text_file(&write_root, &target, &appended(existing, text)).map_err(failed)?;
    }
    writeln!(out, "{}", target.display()).map_err(failed)?;
    if append.is_none() {
        open_in_viewer(&target)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(3600)
            .unwrap()
            .with_ymd_and_hms(y, mo, d, h, mi, 5)
            .unwrap()
    }

    #[test]
    fn formats_moment_tokens() {
        let d = at(2026, 3, 2, 14, 7);
        assert_eq!(format_moment(&d, "YYYY-MM-DD"), "2026-03-02");
        assert_eq!(
            format_moment(&d, "YYYY/MM/YYYY-MM-DD"),
            "2026/03/2026-03-02"
        );
        assert_eq!(
            format_moment(&d, "dddd, MMMM Do YYYY"),
            "Monday, March 2nd 2026"
        );
        assert_eq!(
            format_moment(&d, "[Week] W · hh:mm A Z"),
            "Week 10 · 02:07 PM +01:00"
        );
        assert_eq!(format_moment(&d, "DDDD YY E"), "061 26 1");
    }

    #[test]
    fn expands_template_variables() {
        let d = at(2026, 3, 2, 14, 7);
        let t = "# {{title}} {{date}} {{ time }} {{date:dddd}} {{unknown}} {{";
        assert_eq!(
            expand_template(t, "2026-03-02", &d),
            "# 2026-03-02 2026-03-02 14:07 Monday {{unknown}} {{"
        );
    }

    #[test]
    fn builds_the_path_and_refuses_escapes() {
        let d = at(2026, 3, 2, 14, 7);
        let mut config = fileops::DailyNotesConfig::default();
        assert_eq!(daily_path(&config, &d).unwrap(), "2026-03-02.md");
        config.folder = Some("Journal".into());
        config.format = Some("YYYY/MM/YYYY-MM-DD".into());
        assert_eq!(
            daily_path(&config, &d).unwrap(),
            "Journal/2026/03/2026-03-02.md"
        );
        config.folder = Some("../out".into());
        assert!(daily_path(&config, &d).is_err());
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-daily-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".obsidian")).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    #[test]
    fn creates_from_the_template_then_appends() {
        let root = tmp("run");
        std::fs::write(
            root.join(".obsidian/daily-notes.json"),
            r#"{"folder":"Journal","format":"YYYY/MM/YYYY-MM-DD","template":"Templates/Daily"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join("Templates")).unwrap();
        std::fs::write(root.join("Templates/Daily.md"), "# {{title}}\n").unwrap();
        let now = at(2026, 3, 2, 14, 7);
        let mut out = Vec::new();
        run(&root, Some("- one"), now, &mut out).unwrap();
        run(&root, Some("- two"), now, &mut out).unwrap();
        let note = root.join("Journal/2026/03/2026-03-02.md");
        assert_eq!(
            std::fs::read_to_string(note).unwrap(),
            "# 2026-03-02\n- one\n- two\n"
        );
        let printed = String::from_utf8(out).unwrap();
        assert_eq!(printed.lines().count(), 2);
        assert!(printed.contains("2026-03-02.md"));
    }

    #[test]
    fn a_missing_template_fails_without_creating_the_note() {
        let root = tmp("missing");
        std::fs::write(
            root.join(".obsidian/daily-notes.json"),
            r#"{"template":"Nope"}"#,
        )
        .unwrap();
        let err = run(&root, Some("x"), at(2026, 3, 2, 1, 1), &mut Vec::new()).unwrap_err();
        assert!(matches!(err, CliError::Failed(m) if m.contains("Nope")));
        assert!(!root.join("2026-03-02.md").exists());
    }
}
