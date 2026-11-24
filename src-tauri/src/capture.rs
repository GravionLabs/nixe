//! Capture from anywhere (#118): the global shortcut opens a small window, its text goes to
//! today's daily note or becomes a new note in the inbox folder. The settings come from the app
//! settings file, because the window may open while Nixe has no main window.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, FixedOffset};

use crate::cli::CliError;
use crate::cli_write::{appended, inbox_folder};
use crate::{daily, fileops, vault, write};

/// How long fetching the title of a page may take.
pub const TITLE_TIMEOUT: Duration = Duration::from_secs(2);
/// A page is read only up to here; the title is in the head.
const MAX_PAGE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Daily,
    Inbox,
}

/// The `capture*` keys of `settings.json`, with the daily notes keys as fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// Tauri accelerator such as `CommandOrControl+Shift+Space`; empty turns capture off.
    pub shortcut: String,
    pub target: Target,
    /// Vault-relative inbox folder; empty uses the new-note folder of the vault, else `Inbox`.
    pub inbox: String,
    /// Vault-relative template note of a new inbox note; `{{content}}` marks the captured text.
    pub template: String,
    /// The vault the app had open last.
    pub vault: Option<PathBuf>,
    pub daily: fileops::DailyNotesConfig,
}

/// The configuration from the text of `settings.json` (`None` or damaged text: capture is off).
pub fn parse_config(settings: Option<&str>) -> Config {
    let json = settings
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .unwrap_or_default();
    let text = |key: &str| {
        json.get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or_default()
            .to_string()
    };
    let some = |key: &str| Some(text(key)).filter(|v| !v.is_empty());
    Config {
        shortcut: text("captureShortcut"),
        target: if text("captureTarget") == "inbox" {
            Target::Inbox
        } else {
            Target::Daily
        },
        inbox: text("captureInbox"),
        template: text("captureTemplate"),
        vault: some("lastFolder").map(PathBuf::from).filter(|p| p.is_dir()),
        daily: fileops::DailyNotesConfig {
            folder: some("dailyFolder"),
            format: some("dailyFormat"),
            template: some("dailyTemplate"),
        },
    }
}

/// The daily notes settings of the vault; the app settings fill each key the vault leaves out.
fn daily_config(root: &Path, config: &Config) -> fileops::DailyNotesConfig {
    let vault = fileops::daily_notes_config(root);
    fileops::DailyNotesConfig {
        folder: vault.folder.or_else(|| config.daily.folder.clone()),
        format: vault.format.or_else(|| config.daily.format.clone()),
        template: vault.template.or_else(|| config.daily.template.clone()),
    }
}

fn read_template(root: &Path, template: &str) -> Result<String, String> {
    let rel = template.replace('\\', "/");
    let rel = rel.trim_matches('/');
    if rel.split('/').any(|c| c == "..") || rel.contains(':') {
        return Err(format!("{template}: outside the vault"));
    }
    let rel = if rel.to_lowercase().ends_with(".md") {
        rel.to_string()
    } else {
        format!("{rel}.md")
    };
    std::fs::read_to_string(root.join(&rel)).map_err(|e| format!("template {rel}: {e}"))
}

/// The content of a new inbox note: the template with `{{content}}` replaced by the text, or the
/// template followed by the text when it has no such mark.
fn inbox_content(template: &str, title: &str, text: &str, now: &DateTime<FixedOffset>) -> String {
    let expanded = daily::expand_template(template, title, now);
    if expanded.contains("{{content}}") {
        let mut out = expanded.replace("{{content}}", text);
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out
    } else if expanded.is_empty() {
        appended(String::new(), text)
    } else {
        appended(expanded, text)
    }
}

/// A file name for the captured text that does not exist yet in `dir`.
fn free_note_path(dir: &Path, stem: &str) -> PathBuf {
    let mut path = dir.join(format!("{stem}.md"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} {n}.md"));
        n += 1;
    }
    path
}

/// Writes the captured text and returns the note. The write is atomic (`write::write_text_file`),
/// so the next auto-sync commits a whole note.
pub fn save(
    root: &Path,
    config: &Config,
    text: &str,
    now: &DateTime<FixedOffset>,
) -> Result<PathBuf, String> {
    let text = text.trim_end();
    if text.trim().is_empty() {
        return Err("nothing to capture".into());
    }
    let root = dunce::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    match config.target {
        Target::Daily => {
            let target = daily::ensure_with(&root, &daily_config(&root, config), now).map_err(
                |e| match e {
                    CliError::Usage(m) | CliError::Failed(m) => m,
                },
            )?;
            let existing = std::fs::read_to_string(&target)
                .map_err(|e| format!("{}: {e}", target.display()))?;
            let write_root = write::write_root(Some(&root), None, &target)?;
            write::write_text_file(&write_root, &target, &appended(existing, text))?;
            Ok(target)
        }
        Target::Inbox => {
            let folder = if config.inbox.is_empty() {
                inbox_folder(&root)
            } else {
                config.inbox.clone()
            };
            let rel = folder.replace('\\', "/");
            let rel = rel.trim_matches('/');
            if rel.contains(':') || rel.split('/').any(|c| c == "..") {
                return Err(format!("{folder}: outside the vault"));
            }
            let dir = root.join(rel);
            fileops::create_dir(&root, &dir)?;
            let stem = daily::format_moment(now, "YYYY-MM-DD HHmmss");
            let template = if config.template.is_empty() {
                String::new()
            } else {
                read_template(&root, &config.template)?
            };
            let target = free_note_path(&dir, &stem);
            let content = inbox_content(&template, &stem, text, now);
            let write_root = write::write_root(Some(&root), None, &target)?;
            write::write_text_file(&write_root, &target, &content)?;
            Ok(target)
        }
    }
}

/// The names of the notes of the vault (file name without `.md`), for the `[[` completion.
pub fn note_names(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = vault::list_vault_files(root)
        .iter()
        .filter_map(|p| p.strip_suffix(".md"))
        .filter_map(|p| p.rsplit('/').next())
        .map(str::to_string)
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

/// The text of the `<title>` of an HTML page, whitespace collapsed and entities decoded.
pub fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title")?;
    let raw = html.get(start..end)?;
    let title = decode_entities(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then_some(title)
}

pub(crate) fn decode_entities(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let decoded = after.find(';').filter(|e| *e <= 8).and_then(|e| {
            let name = &after[..e];
            let c = match name {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" => '\'',
                "nbsp" => ' ',
                _ => {
                    let num = name.strip_prefix('#')?;
                    let code = match num.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                        None => num.parse().ok()?,
                    };
                    char::from_u32(code)?
                }
            };
            Some((c, e))
        });
        match decoded {
            Some((c, e)) => {
                out.push(c);
                rest = &after[e + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// True for text that is one `http(s)` URL and nothing else.
pub fn is_url(text: &str) -> bool {
    let t = text.trim();
    (t.starts_with("http://") || t.starts_with("https://"))
        && !t.chars().any(char::is_whitespace)
        && t.len() > "https://".len()
}

/// The title of the page at `url`; `None` when it cannot be fetched within `timeout`.
pub fn fetch_title(url: &str, timeout: Duration) -> Option<String> {
    if !is_url(url) {
        return None;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(true)
        .build()
        .into();
    let mut response = agent.get(url.trim()).call().ok()?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_PAGE_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    extract_title(&String::from_utf8_lossy(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::io::Write;

    fn at() -> DateTime<FixedOffset> {
        FixedOffset::east_opt(0)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 2, 14, 7, 5)
            .unwrap()
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-capture-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    fn config(target: Target) -> Config {
        Config {
            shortcut: "X".into(),
            target,
            inbox: String::new(),
            template: String::new(),
            vault: None,
            daily: fileops::DailyNotesConfig::default(),
        }
    }

    #[test]
    fn reads_the_settings_and_survives_damage() {
        let c = parse_config(Some(
            r#"{"captureShortcut":" Alt+Space ","captureTarget":"inbox","captureInbox":"In","dailyFolder":"J"}"#,
        ));
        assert_eq!(c.shortcut, "Alt+Space");
        assert_eq!(c.target, Target::Inbox);
        assert_eq!(c.inbox, "In");
        assert_eq!(c.daily.folder.as_deref(), Some("J"));
        assert_eq!(c.daily.format, None);
        for bad in [None, Some("{broken"), Some("[]")] {
            let c = parse_config(bad);
            assert_eq!(c.shortcut, "");
            assert_eq!(c.target, Target::Daily);
        }
    }

    #[test]
    fn appends_to_the_daily_note_and_creates_it() {
        let root = tmp("daily");
        let mut c = config(Target::Daily);
        c.daily.folder = Some("Journal".into());
        let path = save(&root, &c, "- first\n", &at()).unwrap();
        save(&root, &c, "- second", &at()).unwrap();
        assert_eq!(path, root.join("Journal/2026-03-02.md"));
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "- first\n- second\n"
        );
    }

    #[test]
    fn the_vault_daily_settings_win_over_the_app_settings() {
        let root = tmp("daily-vault");
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::write(
            root.join(".obsidian/daily-notes.json"),
            r#"{"folder":"Vault"}"#,
        )
        .unwrap();
        let mut c = config(Target::Daily);
        c.daily.folder = Some("App".into());
        c.daily.format = Some("YYYY".into());
        let path = save(&root, &c, "x", &at()).unwrap();
        assert_eq!(path, root.join("Vault/2026.md"));
    }

    #[test]
    fn writes_a_new_inbox_note_each_time() {
        let root = tmp("inbox");
        let mut c = config(Target::Inbox);
        c.inbox = "Capture".into();
        let a = save(&root, &c, "one", &at()).unwrap();
        let b = save(&root, &c, "two", &at()).unwrap();
        assert_eq!(a, root.join("Capture/2026-03-02 140705.md"));
        assert_eq!(b, root.join("Capture/2026-03-02 140705 2.md"));
        assert_eq!(std::fs::read_to_string(a).unwrap(), "one\n");
        assert_eq!(std::fs::read_to_string(b).unwrap(), "two\n");
    }

    #[test]
    fn the_inbox_defaults_to_inbox_and_refuses_escapes() {
        let root = tmp("inbox-default");
        let path = save(&root, &config(Target::Inbox), "x", &at()).unwrap();
        assert_eq!(path.parent().unwrap(), root.join("Inbox"));
        let mut c = config(Target::Inbox);
        c.inbox = "../out".into();
        assert!(save(&root, &c, "x", &at()).is_err());
    }

    #[test]
    fn a_template_wraps_the_text() {
        let root = tmp("template");
        std::fs::create_dir_all(root.join("Templates")).unwrap();
        std::fs::write(
            root.join("Templates/Capture.md"),
            "# {{title}}\n\n{{content}}\n\n#inbox\n",
        )
        .unwrap();
        std::fs::write(root.join("Templates/Plain.md"), "---\ntags: inbox\n---\n").unwrap();
        let mut c = config(Target::Inbox);
        c.template = "Templates/Capture".into();
        let path = save(&root, &c, "hello", &at()).unwrap();
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "# 2026-03-02 140705\n\nhello\n\n#inbox\n"
        );
        c.template = "Templates/Plain.md".into();
        let path = save(&root, &c, "hello", &at()).unwrap();
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "---\ntags: inbox\n---\nhello\n"
        );
        c.template = "Templates/Missing".into();
        assert!(save(&root, &c, "hello", &at()).is_err());
    }

    #[test]
    fn empty_text_is_refused_and_writes_nothing() {
        let root = tmp("empty");
        assert!(save(&root, &config(Target::Daily), " \n", &at()).is_err());
        assert!(!root.join("2026-03-02.md").exists());
    }

    #[test]
    fn lists_note_names_for_the_completion() {
        let root = tmp("names");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("a/Zebra.md"), "").unwrap();
        std::fs::write(root.join("apple.md"), "").unwrap();
        std::fs::write(root.join("pic.png"), "").unwrap();
        assert_eq!(note_names(&root), vec!["apple", "Zebra"]);
    }

    #[test]
    fn extracts_the_title() {
        assert_eq!(
            extract_title("<html><HEAD><Title lang=en>\n Tom &amp; Jerry &#8211; \n Home </TITLE>"),
            Some("Tom & Jerry – Home".into())
        );
        assert_eq!(extract_title("<title></title>"), None);
        assert_eq!(extract_title("<p>no title</p>"), None);
    }

    #[test]
    fn recognises_a_single_url() {
        assert!(is_url(" https://example.com/a?b=1 "));
        assert!(!is_url("https://"));
        assert!(!is_url("see https://example.com"));
        assert!(!is_url("ftp://example.com"));
    }

    fn serve(body: &'static str, delay: Duration) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                std::thread::sleep(delay);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        format!("http://{addr}/")
    }

    #[test]
    fn fetches_the_title_of_a_page() {
        let url = serve("<title>Hello page</title>", Duration::ZERO);
        assert_eq!(
            fetch_title(&url, Duration::from_secs(2)),
            Some("Hello page".into())
        );
    }

    #[test]
    fn a_slow_page_gives_no_title() {
        let url = serve("<title>Late</title>", Duration::from_millis(1500));
        let started = std::time::Instant::now();
        assert_eq!(fetch_title(&url, Duration::from_millis(300)), None);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn text_that_is_no_url_is_not_fetched() {
        assert_eq!(fetch_title("hello", Duration::from_secs(2)), None);
    }
}
