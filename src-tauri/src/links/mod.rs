//! Link notes (`type: link`, see `docs/links.md`): saving a web page as a note (`nixe clip`,
//! `links::clip`: a URL and optionally its rendered HTML become a note in the vault) and the
//! opt-in dead link check. Clipping needs `capture` and the network, so it is desktop only.

#[cfg(desktop)]
pub mod archive;
pub mod dead;
#[cfg(desktop)]
pub mod fetch;
#[cfg(desktop)]
pub mod note;
pub mod url;

/// The clip code lives in one module so that a single `cfg` keeps it off mobile.
#[cfg(desktop)]
mod clip_impl {
    use std::fmt;
    use std::path::{Path, PathBuf};

    use chrono::{DateTime, FixedOffset};
    use serde::Serialize;

    use super::archive;
    use super::fetch::{self, Fetcher};
    use super::note::{self, Note};
    use super::url;
    use crate::capture::is_url;
    use crate::index::{self, read};
    use crate::vault::config::Config;
    use crate::{cli_write, write};

    /// The folder of the link notes until the role `links` of `.nixe/config.json` names one (#504).
    pub const DEFAULT_FOLDER: &str = "Links";

    #[derive(Debug, Clone, Default)]
    pub struct ClipRequest {
        pub url: String,
        /// The page as the caller has it (a browser rendered it); without it the page is fetched.
        pub html: Option<String>,
        /// Wins over every title of the page.
        pub title: Option<String>,
        pub tags: Vec<String>,
        /// Vault-relative; without it the role `links` of `.nixe/config.json`, else [`DEFAULT_FOLDER`].
        pub folder: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    pub struct ClipResult {
        pub path: PathBuf,
        pub created: bool,
        /// Things that went less well than asked, for example a page without readable content.
        #[serde(skip)]
        pub warnings: Vec<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum ClipError {
        /// Not an `http(s)` address.
        Url(String),
        /// The page could not be fetched.
        Fetch(String),
        /// The folder leaves the vault or the note cannot be written.
        Write(String),
    }

    impl fmt::Display for ClipError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                ClipError::Url(m) | ClipError::Fetch(m) | ClipError::Write(m) => f.write_str(m),
            }
        }
    }

    impl std::error::Error for ClipError {}

    /// Saves the page of `req.url` as a link note below `root`.
    /// A URL that a link note of the vault holds already (after [`url::normalize`]) opens that
    /// note instead of a second one. `app_data` holds the index the lookup goes through.
    pub fn clip(root: &Path, app_data: &Path, req: ClipRequest) -> Result<ClipResult, ClipError> {
        clip_with(
            root,
            app_data,
            req,
            &chrono::Local::now().fixed_offset(),
            &fetch::fetch,
        )
    }

    /// [`clip`] with the clock and the fetch given; the tests pass saved pages.
    pub fn clip_with(
        root: &Path,
        app_data: &Path,
        req: ClipRequest,
        now: &DateTime<FixedOffset>,
        fetcher: Fetcher,
    ) -> Result<ClipResult, ClipError> {
        let url = req.url.trim();
        if !is_url(url) {
            return Err(ClipError::Url(format!(
                "{url}: not an http or https address"
            )));
        }
        let root = dunce::canonicalize(root)
            .map_err(|e| ClipError::Write(format!("{}: {e}", root.display())))?;
        let mut warnings = Vec::new();
        if let Some(path) = existing(&root, app_data, url, &mut warnings) {
            return Ok(ClipResult {
                path,
                created: false,
                warnings,
            });
        }
        let html = match req.html {
            Some(html) => html,
            None => {
                let page = fetcher(url)?;
                fetch::decode(&page.bytes, page.content_type.as_deref())
            }
        };
        let meta = note::extract_metadata(&html);

        // The canonical address replaces the given one only when it is an absolute http(s) URL.
        let url = meta
            .canonical
            .as_deref()
            .filter(|c| is_url(c))
            .unwrap_or(url);
        // The page may name another address than the one given: look again under that one.
        if let Some(path) = existing(&root, app_data, url, &mut warnings) {
            return Ok(ClipResult {
                path,
                created: false,
                warnings,
            });
        }
        let url = url::normalize(url);
        let url = url.as_str();
        let host = host_of(url);
        let title = [
            req.title.as_deref(),
            meta.og_title.as_deref(),
            meta.title.as_deref(),
        ]
        .into_iter()
        .flatten()
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|t| !t.is_empty())
        .unwrap_or_else(|| host.clone());
        let archive = match note::reader_markdown(&html, url) {
            Ok(text) => Some(text),
            Err(why) => {
                warnings.push(format!("{url}: {why}; saved without ## Archive"));
                None
            }
        };
        let tags: Vec<String> = req
            .tags
            .iter()
            .map(|t| t.trim().trim_start_matches('#').trim().to_string())
            .filter(|t| !t.is_empty())
            .fold(Vec::new(), |mut all, t| {
                if !all.contains(&t) {
                    all.push(t);
                }
                all
            });
        let site = meta.site_name.clone().unwrap_or_else(|| host.clone());
        let note = Note {
            url,
            title: &title,
            tags: &tags,
            saved: &now.format("%Y-%m-%dT%H:%M:%S%:z").to_string(),
            description: meta.description.as_deref(),
            image: meta.image.as_deref(),
            site: Some(&site),
            archive_files: &[],
            archive: archive.as_deref(),
        };

        // A role outside the vault is ignored with the warning of `Config` (#439).
        let role = Config::load(&root).links_folder();
        let folder = req
            .folder
            .as_deref()
            .or(role.as_deref())
            .unwrap_or(DEFAULT_FOLDER);
        let dir = cli_write::folder_path(&root, folder).map_err(|e| match e {
            crate::cli::CliError::Usage(m) | crate::cli::CliError::Failed(m) => ClipError::Write(m),
        })?;
        let path = free_path(&dir, &note::file_name(&title, &host));
        let archive_files = archive_html(&root, &path, url, &html, fetcher, &mut warnings);
        let text = note::render(&Note {
            archive_files: &archive_files,
            ..note
        });
        let write_root = write::write_root(Some(&root), None, &path).map_err(ClipError::Write)?;
        write::write_text_file(&write_root, &path, &text).map_err(ClipError::Write)?;
        Ok(ClipResult {
            path,
            created: true,
            warnings,
        })
    }

    /// Writes the HTML copy of the page next to the note when `links.archive` asks for it and
    /// returns the file names for the frontmatter (relative to the folder of the note). A copy
    /// that cannot be made is a warning, never a failed clip.
    fn archive_html(
        root: &Path,
        note_path: &Path,
        url: &str,
        html: &str,
        fetcher: Fetcher,
        warnings: &mut Vec<String>,
    ) -> Vec<String> {
        if !Config::load(root)
            .links_archive()
            .iter()
            .any(|k| k == archive::HTML)
        {
            return Vec::new();
        }
        let result = (|| -> Result<String, String> {
            let page = archive::inline_page(html, url, fetcher)?;
            let dir = note_path.parent().ok_or("the note has no folder")?;
            let name = format!(
                "{}.html",
                note_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or("the note has no name")?
            );
            let archive_dir = dir.join(archive::ARCHIVE_DIR);
            // The folder is not synced: the ignore entry comes before the first file.
            let rel = archive_dir
                .strip_prefix(root)
                .map_err(|_| "the archive folder is outside the vault".to_string())?;
            let rel = rel.to_string_lossy().replace('\\', "/");
            crate::git::gitignore_ensure(root, &rel)?;
            std::fs::create_dir_all(&archive_dir).map_err(|e| format!("{rel}: {e}"))?;
            write_archive_file(&archive_dir.join(&name), &page)?;
            Ok(format!("{}/{name}", archive::ARCHIVE_DIR))
        })();
        match result {
            Ok(file) => vec![file],
            Err(why) => {
                warnings.push(format!("{url}: {why}; saved without the HTML archive"));
                Vec::new()
            }
        }
    }

    /// A temp file and a rename, like the notes: no half file.
    fn write_archive_file(path: &Path, text: &str) -> Result<(), String> {
        let tmp = path.with_extension("html.nixe-tmp");
        std::fs::write(&tmp, text)
            .and_then(|()| std::fs::rename(&tmp, path))
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                format!("{}: {e}", path.display())
            })
    }

    /// The note (absolute path) that holds `url` already, found through the index of the vault.
    /// An index that cannot be read is no reason to refuse the clip: it only costs a warning.
    fn existing(
        root: &Path,
        app_data: &Path,
        url: &str,
        warnings: &mut Vec<String>,
    ) -> Option<PathBuf> {
        let wanted = url::normalize(url);
        let found = (|| {
            let mut conn = index::open(&index::index_path(app_data, root))?;
            index::scan(&mut conn, root, |_| {})?;
            read::link_notes_by_url(&conn, &wanted, url::normalize)
        })();
        match found {
            Ok(paths) => paths.first().map(|p| root.join(p)),
            Err(e) => {
                warnings.push(format!(
                    "{url}: index not readable ({e}); not checked for a saved copy"
                ));
                None
            }
        }
    }

    /// `name` in `dir`, or with ` 2`, ` 3`, … before `.md` when a note of that name exists.
    fn free_path(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        if !path.exists() {
            return path;
        }
        let stem = name.strip_suffix(".md").unwrap_or(name);
        (2..)
            .map(|n| dir.join(format!("{stem} {n}.md")))
            .find(|p| !p.exists())
            .unwrap_or(path)
    }

    /// The host of an `http(s)` URL, without port, user info and a leading `www.`.
    fn host_of(url: &str) -> String {
        let rest = url.split_once("://").map_or(url, |(_, r)| r);
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let host = authority.rsplit('@').next().unwrap_or_default();
        let host = host.split(':').next().unwrap_or_default();
        host.strip_prefix("www.").unwrap_or(host).to_string()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::links::fetch::Page;
        use chrono::TimeZone;

        fn at() -> DateTime<FixedOffset> {
            FixedOffset::east_opt(3600)
                .unwrap()
                .with_ymd_and_hms(2026, 11, 20, 9, 30, 0)
                .unwrap()
        }

        fn tmp(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("nixe-clip-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dunce::canonicalize(dir).unwrap()
        }

        fn data(root: &Path) -> PathBuf {
            root.with_extension("data")
        }

        fn fixture(name: &str) -> Vec<u8> {
            std::fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../fixtures/web")
                    .join(name),
            )
            .unwrap()
        }

        /// A fetch that answers with a saved page and counts nothing: the network stays out.
        fn serve(name: &'static str) -> impl Fn(&str) -> Result<Page, ClipError> {
            move |_| {
                Ok(Page {
                    bytes: fixture(name),
                    content_type: Some("text/html".into()),
                })
            }
        }

        fn no_network(url: &str) -> Result<Page, ClipError> {
            panic!("fetched {url}")
        }

        fn request(url: &str) -> ClipRequest {
            ClipRequest {
                url: url.into(),
                ..ClipRequest::default()
            }
        }

        #[test]
        fn clips_an_article() {
            let root = tmp("article");
            let mut req = request("https://example.com/articles/vault-first?utm=1");
            req.tags = vec![
                "#reading".into(),
                "reading".into(),
                " ".into(),
                "web".into(),
            ];
            let r = clip_with(&root, &data(&root), req, &at(), &serve("article.html")).unwrap();
            assert!(r.created);
            assert!(r.warnings.is_empty(), "{:?}", r.warnings);
            assert_eq!(r.path, root.join("Links/Keeping notes as plain files.md"));
            let text = std::fs::read_to_string(&r.path).unwrap();
            assert!(text.starts_with(
            "---\ntype: link\nurl: https://example.com/articles/vault-first\n\
             title: Keeping notes as plain files\ntags:\n  - reading\n  - web\n\
             saved: 2026-11-20T09:30:00+01:00\nstatus: unread\n\
             description: A short article about keeping notes as plain files & folders.\n\
             image: https://example.com/images/vault-first.png\nsite: Example Site\n---\n\n\
             > A short article about keeping notes as plain files & folders.\n\n## Notes\n\n## Archive\n\n"
        ), "{text}");
            assert!(text.contains("Plain files outlive every application."));
            assert!(text.contains("[backup story](https://example.com/backup)"));
            assert!(!text.contains("Copyright Example Site"));
            // The note is a valid link note for the rest of the app.
            let (fm, _) = text[4..].split_once("\n---\n").unwrap();
            let yaml: serde_yaml_ng::Value = serde_yaml_ng::from_str(fm).unwrap();
            assert_eq!(yaml["type"], "link");
        }

        #[test]
        fn given_html_skips_the_fetch_and_the_title_wins() {
            let root = tmp("given");
            let mut req = request("https://example.com/a");
            req.html = Some(String::from_utf8(fixture("article.html")).unwrap());
            req.title = Some("My title".into());
            req.folder = Some("Links/Reading".into());
            let r = clip_with(&root, &data(&root), req, &at(), &no_network).unwrap();
            assert_eq!(r.path, root.join("Links/Reading/My title.md"));
            assert!(std::fs::read_to_string(&r.path)
                .unwrap()
                .contains("title: My title\n"));
        }

        #[test]
        fn a_page_without_an_article_is_saved_with_a_warning() {
            let root = tmp("none");
            let r = clip_with(
                &root,
                &data(&root),
                request("https://example.net/app"),
                &at(),
                &serve("no-article.html"),
            )
            .unwrap();
            assert_eq!(r.warnings.len(), 1, "{:?}", r.warnings);
            assert!(r.warnings[0].contains("Archive"));
            let text = std::fs::read_to_string(&r.path).unwrap();
            assert!(!text.contains("## Archive"));
            assert!(text.contains("title: Dashboard\n"));
            assert!(text.contains("> Only a meta description here.\n"));
            assert!(text.contains("site: example.net\n"));
        }

        #[test]
        fn a_page_in_latin1_is_decoded() {
            let root = tmp("latin1");
            let r = clip_with(
                &root,
                &data(&root),
                request("https://example.de/"),
                &at(),
                &serve("latin1.html"),
            )
            .unwrap();
            let text = std::fs::read_to_string(&r.path).unwrap();
            assert_eq!(r.path.file_name().unwrap(), "Café über alles.md");
            assert!(text.contains("description: Größe und Fläche\n"), "{text}");
            assert!(text.contains("Der Käse ist für die Größe der Fläche wichtig"));
        }

        #[test]
        fn a_page_without_a_title_is_named_after_its_host() {
            let root = tmp("notitle");
            let url = "https://www.example.org:8080/x";
            let r = clip_with(
                &root,
                &data(&root),
                request(url),
                &at(),
                &serve("no-title.html"),
            )
            .unwrap();
            assert_eq!(r.path, root.join("Links/example.org.md"));
            let text = std::fs::read_to_string(&r.path).unwrap();
            assert!(text.contains("title: example.org\n"));
            assert!(text.contains("url: https://www.example.org:8080/x\n"));
            // Another page of the same name does not replace the note.
            let again = clip_with(
                &root,
                &data(&root),
                request("https://www.example.org:8080/y"),
                &at(),
                &serve("no-title.html"),
            )
            .unwrap();
            assert_eq!(again.path, root.join("Links/example.org 2.md"));
            assert!(r.path.exists());
        }

        #[test]
        fn the_same_url_opens_the_existing_note() {
            let root = tmp("twice");
            let first = clip_with(
                &root,
                &data(&root),
                request("https://Example.com/articles/vault-first?utm_source=a#top"),
                &at(),
                &serve("article.html"),
            )
            .unwrap();
            assert!(first.created);
            let text = std::fs::read_to_string(&first.path).unwrap();
            assert!(
                text.contains("url: https://example.com/articles/vault-first\n"),
                "{text}"
            );
            // Another spelling of the address: no fetch, no second note.
            let again = clip_with(
                &root,
                &data(&root),
                request("https://example.com/articles/vault-first/?fbclid=x"),
                &at(),
                &no_network,
            )
            .unwrap();
            assert!(!again.created);
            assert_eq!(again.path, first.path);
            assert_eq!(std::fs::read_dir(root.join("Links")).unwrap().count(), 1);
            // Another page is a new note.
            let other = clip_with(
                &root,
                &data(&root),
                request("https://example.com/articles/other"),
                &at(),
                &serve("no-title.html"),
            )
            .unwrap();
            assert!(other.created);
            assert_ne!(other.path, first.path);
        }

        #[test]
        fn the_canonical_address_of_the_page_is_looked_up_too() {
            let root = tmp("canonical");
            let first = clip_with(
                &root,
                &data(&root),
                request("https://example.com/articles/vault-first"),
                &at(),
                &serve("article.html"),
            )
            .unwrap();
            let again = clip_with(
                &root,
                &data(&root),
                request("https://example.com/share/123"),
                &at(),
                &serve("article.html"),
            )
            .unwrap();
            assert!(!again.created);
            assert_eq!(again.path, first.path);
        }

        #[test]
        fn an_old_note_with_an_unnormalized_url_and_a_non_link_note_with_the_url() {
            let root = tmp("old");
            std::fs::create_dir_all(root.join("Links")).unwrap();
            std::fs::write(
                root.join("Links/Old.md"),
                "---\ntype: link\nurl: https://X.test/p/?utm_medium=m\n---\n",
            )
            .unwrap();
            std::fs::write(root.join("Plain.md"), "---\nurl: https://y.test/p\n---\n").unwrap();
            let old = clip_with(
                &root,
                &data(&root),
                request("https://x.test/p"),
                &at(),
                &no_network,
            )
            .unwrap();
            assert!(!old.created);
            assert_eq!(old.path, root.join("Links/Old.md"));
            let mut req = request("https://y.test/p");
            req.html = Some("<title>Y</title>".into());
            assert!(
                clip_with(&root, &data(&root), req, &at(), &no_network)
                    .unwrap()
                    .created
            );
        }

        /// The assets of `fixtures/web/archive.html`.
        fn assets(url: &str) -> Result<Page, ClipError> {
            let (name, mime) = match url {
                "https://example.com/img/pic.png" | "https://example.com/img/bg.png" => {
                    ("archive-pixel.png", "image/png")
                }
                "https://example.com/static/site.css" => ("archive.css", "text/css"),
                _ => return Err(ClipError::Fetch(format!("{url}: 404"))),
            };
            Ok(Page {
                bytes: fixture(name),
                content_type: Some(mime.into()),
            })
        }

        fn clip_archive(name: &str, config: Option<&str>, git: bool) -> (PathBuf, ClipResult) {
            let root = tmp(name);
            if git {
                git2::Repository::init(&root).unwrap();
            }
            if let Some(config) = config {
                std::fs::create_dir_all(root.join(".nixe")).unwrap();
                std::fs::write(root.join(".nixe/config.json"), config).unwrap();
            }
            let mut req = request("https://example.com/a");
            req.html = Some(String::from_utf8(fixture("archive.html")).unwrap());
            let r = clip_with(&root, &data(&root), req, &at(), &assets).unwrap();
            (root, r)
        }

        #[test]
        fn without_the_setting_no_archive_is_written() {
            for config in [None, Some(r#"{"links":{"archive":[]}}"#)] {
                let (root, r) = clip_archive("archive-off", config, true);
                assert!(!root.join("Links/.archive").exists());
                assert!(!root.join(".gitignore").exists());
                let text = std::fs::read_to_string(&r.path).unwrap();
                assert!(!text.contains("archive:"), "{text}");
            }
        }

        #[test]
        fn the_html_setting_writes_one_file_and_names_it_in_the_note() {
            let (root, r) = clip_archive(
                "archive-html",
                Some(r#"{"links":{"archive":["html"]}}"#),
                true,
            );
            assert!(r.warnings.is_empty(), "{:?}", r.warnings);
            assert_eq!(r.path, root.join("Links/Archive Page.md"));
            let text = std::fs::read_to_string(&r.path).unwrap();
            assert!(
                text.contains("\narchive:\n  - .archive/Archive Page.html\n---\n"),
                "{text}"
            );
            let file =
                std::fs::read_to_string(root.join("Links/.archive/Archive Page.html")).unwrap();
            assert!(file.contains("<img src=\"data:image/png;base64,"), "{file}");
            assert!(file.contains("<style>body { background: url(\"data:image/png"));
            assert!(!file.contains("<script"));
            // The folder is ignored by Git and the file with it; nothing else is touched.
            assert_eq!(
                std::fs::read_to_string(root.join(".gitignore")).unwrap(),
                "# Nixe\nLinks/.archive/\n"
            );
            assert!(git2::Repository::open(&root)
                .unwrap()
                .is_path_ignored("Links/.archive/Archive Page.html")
                .unwrap());
            // The frontmatter is still valid YAML.
            let (fm, _) = text[4..].split_once("\n---\n").unwrap();
            let yaml: serde_yaml_ng::Value = serde_yaml_ng::from_str(fm).unwrap();
            assert_eq!(yaml["archive"][0], ".archive/Archive Page.html");
        }

        #[test]
        fn the_gitignore_is_appended_to_and_not_rewritten() {
            let root = tmp("archive-gitignore");
            std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
            std::fs::create_dir_all(root.join(".nixe")).unwrap();
            std::fs::write(
                root.join(".nixe/config.json"),
                r#"{"links":{"archive":["html"]},"folders":{"links":"Reading"}}"#,
            )
            .unwrap();
            for url in ["https://example.com/a", "https://example.com/b"] {
                let mut req = request(url);
                req.html = Some(String::from_utf8(fixture("archive.html")).unwrap());
                clip_with(&root, &data(&root), req, &at(), &assets).unwrap();
            }
            assert_eq!(
                std::fs::read_to_string(root.join(".gitignore")).unwrap(),
                "build/\n\n# Nixe\nReading/.archive/\n"
            );
            assert!(root.join("Reading/.archive/Archive Page.html").is_file());
            assert!(root.join("Reading/.archive/Archive Page 2.html").is_file());
        }

        #[test]
        fn an_archive_that_cannot_be_written_is_a_warning_and_the_note_is_saved() {
            let root = tmp("archive-blocked");
            std::fs::create_dir_all(root.join(".nixe")).unwrap();
            std::fs::write(
                root.join(".nixe/config.json"),
                r#"{"links":{"archive":["html"]}}"#,
            )
            .unwrap();
            // A file where the folder should be.
            std::fs::create_dir_all(root.join("Links")).unwrap();
            std::fs::write(root.join("Links/.archive"), "").unwrap();
            let mut req = request("https://example.com/a");
            req.html = Some("<title>Blocked</title>".into());
            let r = clip_with(&root, &data(&root), req, &at(), &no_network).unwrap();
            assert!(r.created);
            assert!(
                r.warnings
                    .iter()
                    .any(|w| w.contains("saved without the HTML archive")),
                "{:?}",
                r.warnings
            );
            assert!(!std::fs::read_to_string(&r.path)
                .unwrap()
                .contains("archive:"));
        }

        fn clip_with_config(name: &str, config: Option<&str>) -> (PathBuf, ClipResult) {
            let root = tmp(name);
            if let Some(config) = config {
                std::fs::create_dir_all(root.join(".nixe")).unwrap();
                std::fs::write(root.join(".nixe/config.json"), config).unwrap();
            }
            let mut req = request("https://example.com/a");
            req.html = Some("<title>T</title>".into());
            let r = clip_with(&root, &data(&root), req, &at(), &no_network).unwrap();
            (root, r)
        }

        #[test]
        fn the_role_links_sets_the_folder_of_new_link_notes() {
            let (root, r) =
                clip_with_config("role-set", Some(r#"{"folders":{"links":"Web/Saved"}}"#));
            assert_eq!(r.path, root.join("Web/Saved/T.md"));
            assert!(!root.join("Links").exists());
        }

        #[test]
        fn without_the_role_links_the_folder_is_links() {
            for (name, config) in [
                ("role-none", None),
                ("role-other", Some(r#"{"folders":{"inbox":"In"}}"#)),
            ] {
                let (root, r) = clip_with_config(name, config);
                assert_eq!(r.path, root.join("Links/T.md"), "{name}");
            }
        }

        #[test]
        fn a_role_outside_the_vault_is_ignored_and_the_folder_is_links() {
            for (i, role) in ["../out", "/abs/../..", "C:/x", "a/../../b"]
                .iter()
                .enumerate()
            {
                let config = format!(r#"{{"folders":{{"links":"{role}"}}}}"#);
                let (root, r) = clip_with_config(&format!("role-out{i}"), Some(&config));
                assert_eq!(r.path, root.join("Links/T.md"), "{role}");
            }
        }

        #[test]
        fn the_given_folder_wins_over_the_role_links() {
            let root = tmp("role-wins");
            std::fs::create_dir_all(root.join(".nixe")).unwrap();
            std::fs::write(
                root.join(".nixe/config.json"),
                r#"{"folders":{"links":"Web"}}"#,
            )
            .unwrap();
            let mut req = request("https://example.com/a");
            req.html = Some("<title>T</title>".into());
            req.folder = Some("Mine".into());
            let r = clip_with(&root, &data(&root), req, &at(), &no_network).unwrap();
            assert_eq!(r.path, root.join("Mine/T.md"));
        }

        #[test]
        fn refuses_bad_urls_folders_and_failed_fetches() {
            let root = tmp("refuse");
            for url in ["ftp://x.test/", "example.com", "https://a b"] {
                assert!(matches!(
                    clip_with(&root, &data(&root), request(url), &at(), &no_network),
                    Err(ClipError::Url(_))
                ));
            }
            let mut req = request("https://x.test/");
            req.html = Some("<title>T</title>".into());
            for folder in ["../out", "/abs", "C:/x", "a/../../b"] {
                req.folder = Some(folder.into());
                assert!(
                    matches!(
                        clip_with(&root, &data(&root), req.clone(), &at(), &no_network),
                        Err(ClipError::Write(_))
                    ),
                    "{folder}"
                );
            }
            let fail = |_: &str| Err(ClipError::Fetch("boom".into()));
            assert_eq!(
                clip_with(
                    &root,
                    &data(&root),
                    request("https://x.test/"),
                    &at(),
                    &fail
                ),
                Err(ClipError::Fetch("boom".into()))
            );
            assert!(!root.join("Links").exists());
        }
    }
}
#[cfg(desktop)]
pub use clip_impl::*;
