//! Link notes (`type: link`, see `docs/links.md`): saving a web page as a note (`nixe clip`,
//! `links::clip`: a URL and optionally its rendered HTML become a note in the vault) and the
//! opt-in dead link check. Clipping needs `capture` and the network, so it is desktop only.

pub mod dead;
#[cfg(desktop)]
pub mod fetch;
#[cfg(desktop)]
pub mod note;

/// The clip code lives in one module so that a single `cfg` keeps it off mobile.
#[cfg(desktop)]
mod clip_impl {
    use std::fmt;
    use std::path::{Path, PathBuf};

    use chrono::{DateTime, FixedOffset};
    use serde::Serialize;

    use super::fetch::{self, Fetcher};
    use super::note::{self, Note};
    use crate::capture::is_url;
    use crate::{cli_write, write};

    /// The folder of the link notes until `.nixe/config.json` names one (#504).
    pub const DEFAULT_FOLDER: &str = "Links";

    #[derive(Debug, Clone, Default)]
    pub struct ClipRequest {
        pub url: String,
        /// The page as the caller has it (a browser rendered it); without it the page is fetched.
        pub html: Option<String>,
        /// Wins over every title of the page.
        pub title: Option<String>,
        pub tags: Vec<String>,
        /// Vault-relative; without it [`DEFAULT_FOLDER`].
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
    pub fn clip(root: &Path, req: ClipRequest) -> Result<ClipResult, ClipError> {
        clip_with(
            root,
            req,
            &chrono::Local::now().fixed_offset(),
            &fetch::fetch,
        )
    }

    /// [`clip`] with the clock and the fetch given; the tests pass saved pages.
    pub fn clip_with(
        root: &Path,
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
        let html = match req.html {
            Some(html) => html,
            None => {
                let page = fetcher(url)?;
                fetch::decode(&page.bytes, page.content_type.as_deref())
            }
        };
        let root = dunce::canonicalize(root)
            .map_err(|e| ClipError::Write(format!("{}: {e}", root.display())))?;
        let meta = note::extract_metadata(&html);
        let mut warnings = Vec::new();

        // The canonical address replaces the given one only when it is an absolute http(s) URL.
        let url = meta
            .canonical
            .as_deref()
            .filter(|c| is_url(c))
            .unwrap_or(url);
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
        let text = note::render(&Note {
            url,
            title: &title,
            tags: &tags,
            saved: &now.format("%Y-%m-%dT%H:%M:%S%:z").to_string(),
            description: meta.description.as_deref(),
            image: meta.image.as_deref(),
            site: Some(&site),
            archive: archive.as_deref(),
        });

        let folder = req.folder.as_deref().unwrap_or(DEFAULT_FOLDER);
        let dir = cli_write::folder_path(&root, folder).map_err(|e| match e {
            crate::cli::CliError::Usage(m) | crate::cli::CliError::Failed(m) => ClipError::Write(m),
        })?;
        let path = free_path(&dir, &note::file_name(&title, &host));
        let write_root = write::write_root(Some(&root), None, &path).map_err(ClipError::Write)?;
        write::write_text_file(&write_root, &path, &text).map_err(ClipError::Write)?;
        Ok(ClipResult {
            path,
            created: true,
            warnings,
        })
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
            let r = clip_with(&root, req, &at(), &serve("article.html")).unwrap();
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
            let r = clip_with(&root, req, &at(), &no_network).unwrap();
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
            let r = clip_with(&root, request(url), &at(), &serve("no-title.html")).unwrap();
            assert_eq!(r.path, root.join("Links/example.org.md"));
            let text = std::fs::read_to_string(&r.path).unwrap();
            assert!(text.contains("title: example.org\n"));
            assert!(text.contains("url: https://www.example.org:8080/x\n"));
            // The same page again does not replace the note.
            let again = clip_with(&root, request(url), &at(), &serve("no-title.html")).unwrap();
            assert_eq!(again.path, root.join("Links/example.org 2.md"));
            assert!(r.path.exists());
        }

        #[test]
        fn refuses_bad_urls_folders_and_failed_fetches() {
            let root = tmp("refuse");
            for url in ["ftp://x.test/", "example.com", "https://a b"] {
                assert!(matches!(
                    clip_with(&root, request(url), &at(), &no_network),
                    Err(ClipError::Url(_))
                ));
            }
            let mut req = request("https://x.test/");
            req.html = Some("<title>T</title>".into());
            for folder in ["../out", "/abs", "C:/x", "a/../../b"] {
                req.folder = Some(folder.into());
                assert!(
                    matches!(
                        clip_with(&root, req.clone(), &at(), &no_network),
                        Err(ClipError::Write(_))
                    ),
                    "{folder}"
                );
            }
            let fail = |_: &str| Err(ClipError::Fetch("boom".into()));
            assert_eq!(
                clip_with(&root, request("https://x.test/"), &at(), &fail),
                Err(ClipError::Fetch("boom".into()))
            );
            assert!(!root.join("Links").exists());
        }
    }
}
#[cfg(desktop)]
pub use clip_impl::*;
