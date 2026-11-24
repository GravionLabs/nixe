//! The optional HTML archive of a link note (#505): the page as one self-contained file in
//! `<links folder>/.archive/`, images and style sheets inlined as data URIs. Scripts are dropped,
//! so the file shows the page as it was saved and runs nothing (no scripts, event handlers, `javascript:` addresses, frames). The folder is not synced by Git
//! (see `crate::git::gitignore_ensure`).

use base64::Engine;

use super::fetch::{Fetcher, Page};
use super::note::attributes;
use super::url::resolve;

/// The folder next to the link notes that holds the archive files.
pub const ARCHIVE_DIR: &str = ".archive";
/// The setting value of `links.archive` that asks for the HTML copy.
pub const HTML: &str = "html";
/// An archive file is never larger than this; a page that needs more is saved without it.
pub const MAX_ARCHIVE_BYTES: usize = 10 * 1024 * 1024;
/// A single asset above this size stays a link to its address.
pub const MAX_ASSET_BYTES: usize = 2 * 1024 * 1024;

struct Inliner<'a> {
    fetcher: Fetcher<'a>,
    /// What the data URIs may still add to the file.
    budget: usize,
}

impl Inliner<'_> {
    /// The bytes of `url`, when they are small enough for the rest of the budget.
    fn load(&mut self, url: &str) -> Option<Page> {
        let page = (self.fetcher)(url).ok()?;
        // base64 grows the bytes by a third.
        let encoded = page.bytes.len().div_ceil(3) * 4;
        if page.bytes.len() > MAX_ASSET_BYTES || encoded > self.budget {
            return None;
        }
        self.budget -= encoded;
        Some(page)
    }

    /// `reference` of the page `base` as a `data:` URI; `None` leaves the reference as it is.
    fn data_uri(&mut self, base: &str, reference: &str) -> Option<String> {
        let url = resolve(base, reference)?;
        let page = self.load(&url)?;
        let mime = mime_of(&url, page.content_type.as_deref());
        let data = base64::engine::general_purpose::STANDARD.encode(&page.bytes);
        Some(format!("data:{mime};base64,{data}"))
    }

    /// The style sheet at `url`, its `url(…)` references inlined.
    fn stylesheet(&mut self, url: &str) -> Option<String> {
        let page = self.load(url)?;
        let css = super::fetch::decode(&page.bytes, page.content_type.as_deref());
        Some(self.css(&css, url))
    }

    /// `css` with every `url(…)` that leads to a file replaced by a data URI.
    fn css(&mut self, css: &str, base: &str) -> String {
        let mut out = String::with_capacity(css.len());
        let lower = css.to_ascii_lowercase();
        let mut rest = css;
        let mut rest_lower = lower.as_str();
        while let Some(at) = rest_lower.find("url(") {
            out.push_str(&rest[..at + 4]);
            let after = &rest[at + 4..];
            let Some(close) = after.find(')') else {
                rest = after;
                break;
            };
            let raw = &after[..close];
            let reference = raw.trim().trim_matches(['"', '\'']);
            match self.data_uri(base, reference) {
                Some(uri) => out.push_str(&format!("\"{uri}\"")),
                None => out.push_str(raw),
            }
            out.push(')');
            rest = &after[close + 1..];
            rest_lower = &rest_lower[rest_lower.len() - rest.len()..];
        }
        out.push_str(rest);
        out
    }
}

/// The MIME type of an asset: the header when it is one, else the file extension.
fn mime_of(url: &str, content_type: Option<&str>) -> String {
    if let Some(mime) = content_type
        .and_then(|c| c.split(';').next())
        .map(|m| m.trim().to_ascii_lowercase())
        .filter(|m| m.contains('/') && m != "text/html" && m != "application/octet-stream")
    {
        return mime;
    }
    let path = url.split(['?', '#']).next().unwrap_or_default();
    let ext = path
        .rsplit_once('.')
        .map_or("", |(_, e)| e)
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "css" => "text/css",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// The end of the tag that starts at `start` (`<`): the index after its `>`; quoted attribute
/// values may hold a `>`.
fn tag_end(html: &str, start: usize) -> Option<usize> {
    let mut quote = None;
    for (i, c) in html[start..].char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, '>') => return Some(start + i + 1),
            _ => {}
        }
    }
    None
}

fn escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('"', "&quot;")
}

fn is_active(key: &str, value: &str) -> bool {
    let v: String = value
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .collect();
    key.starts_with("on") || v.to_ascii_lowercase().starts_with("javascript:")
}

fn needs_cleaning(attrs: &[(String, String)]) -> bool {
    attrs.iter().any(|(k, v)| is_active(k, v))
}

/// The attributes without event handlers and without `javascript:` addresses.
fn safe(mut attrs: Vec<(String, String)>) -> Vec<(String, String)> {
    attrs.retain(|(k, v)| !is_active(k, v));
    attrs
}

/// The tag `name` with the attributes `attrs`.
fn render_tag(name: &str, attrs: &[(String, String)]) -> String {
    let mut out = format!("<{name}");
    for (key, value) in attrs {
        if value.is_empty() {
            out.push_str(&format!(" {key}"));
        } else {
            out.push_str(&format!(" {key}=\"{}\"", escape(value)));
        }
    }
    out.push('>');
    out
}

/// The page as one file: `<img>` and `<link rel=stylesheet>` inlined, `url(…)` of the style
/// sheets and of `style` attributes and elements inlined, `<script>` removed. An asset that
/// cannot be fetched or does not fit the budget keeps its absolute address. `Err` when the page
/// alone is larger than [`MAX_ARCHIVE_BYTES`].
pub fn inline_page(html: &str, page_url: &str, fetcher: Fetcher) -> Result<String, String> {
    if html.len() > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "the page is larger than {} MiB",
            MAX_ARCHIVE_BYTES / (1024 * 1024)
        ));
    }
    let mut inl = Inliner {
        fetcher,
        budget: MAX_ARCHIVE_BYTES - html.len(),
    };
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    while let Some(found) = html[at..].find('<') {
        let start = at + found;
        out.push_str(&html[at..start]);
        let is_tag = html[start + 1..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic());
        if !is_tag {
            out.push('<');
            at = start + 1;
            continue;
        }
        if html[start..].starts_with("<!--") {
            // A comment holds no tags: `<!-- <script src=a.js> -->` is text.
            let end = html[start + 4..]
                .find("-->")
                .map_or(html.len(), |i| start + 4 + i + 3);
            out.push_str(&html[start..end]);
            at = end;
            continue;
        }
        let Some(end) = tag_end(html, start) else {
            out.push_str(&html[start..]);
            at = html.len();
            break;
        };
        let inner = &html[start + 1..end - 1];
        let name = inner
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        at = end;
        match name.as_str() {
            "script" => {
                // Gone with its content.
                // An unclosed one loses only its own tag, never the rest of the page.
                at = lower[end..]
                    .find("</script")
                    .and_then(|i| tag_end(html, end + i))
                    .unwrap_or(end);
            }
            "style" => {
                let close = lower[end..].find("</style").map_or(html.len(), |i| end + i);
                out.push_str(&html[start..end]);
                out.push_str(&inl.css(&html[end..close], page_url));
                at = close;
            }
            // Frames, plug-ins and a meta refresh load or run what the archive must not.
            "iframe" | "object" | "embed" | "frame" | "frameset" => {}
            "meta" if inner.to_ascii_lowercase().contains("http-equiv") => {}
            "img" => {
                let mut attrs = attributes(inner);
                let src = attrs.iter().position(|(k, _)| k == "src");
                if let Some(i) = src {
                    if let Some(uri) = inl.data_uri(page_url, &attrs[i].1) {
                        attrs[i].1 = uri;
                        // The candidates of `srcset` would load from the network.
                        attrs.retain(|(k, _)| k != "srcset");
                    } else if let Some(url) = resolve(page_url, &attrs[i].1) {
                        attrs[i].1 = url;
                    }
                }
                out.push_str(&render_tag("img", &safe(attrs)));
            }
            "link" => {
                let attrs = attributes(inner);
                let alternate = attrs.iter().any(|(k, v)| {
                    k == "rel"
                        && v.split_whitespace()
                            .any(|t| t.eq_ignore_ascii_case("alternate"))
                });
                let get = |key: &str| {
                    attrs
                        .iter()
                        .find(|(k, _)| k == key)
                        .map(|(_, v)| v.as_str())
                };
                let is_sheet = get("rel").is_some_and(|r| {
                    r.split_whitespace()
                        .any(|t| t.eq_ignore_ascii_case("stylesheet"))
                });
                let sheet = (is_sheet && !alternate)
                    .then(|| get("href"))
                    .flatten()
                    .and_then(|href| resolve(page_url, href))
                    .and_then(|url| inl.stylesheet(&url));
                match sheet {
                    Some(css) => {
                        let media = get("media").map(|m| format!(" media=\"{}\"", escape(m)));
                        out.push_str(&format!(
                            "<style{}>{css}</style>",
                            media.unwrap_or_default()
                        ));
                    }
                    None => out.push_str(&render_tag("link", &safe(attrs.clone()))),
                }
            }
            _ => {
                let mut attrs = attributes(inner);
                if inner.to_ascii_lowercase().contains("style") && inner.contains("url(") {
                    for (key, value) in &mut attrs {
                        if key == "style" {
                            *value = inl.css(value, page_url);
                        }
                    }
                }
                if needs_cleaning(&attrs) || inner.contains("url(") {
                    out.push_str(&render_tag(&name, &safe(attrs)));
                } else {
                    out.push_str(&html[start..end]);
                }
            }
        }
    }
    out.push_str(&html[at..]);
    Ok(with_utf8_charset(out))
}

/// The page is UTF-8 now whatever it declared: the first `<meta charset>` wins in a browser.
fn with_utf8_charset(html: String) -> String {
    let lower = html.to_ascii_lowercase();
    let head = lower.find("<head").and_then(|i| tag_end(&html, i));
    match head {
        Some(end) => format!("{}<meta charset=\"utf-8\">{}", &html[..end], &html[end..]),
        None => format!("<meta charset=\"utf-8\">{html}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::links::clip_impl::ClipError;
    use std::cell::RefCell;
    use std::path::Path;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../fixtures/web")
                .join(name),
        )
        .unwrap()
    }

    /// The assets of `archive.html`; everything else is a 404.
    fn site(url: &str) -> Result<Page, ClipError> {
        let (name, mime) = match url {
            "https://example.com/articles/img/pic.png" => ("archive-pixel.png", "image/png"),
            "https://example.com/static/site.css" => ("archive.css", "text/css; charset=utf-8"),
            "https://example.com/img/bg.png" => ("archive-pixel.png", "image/png"),
            _ => return Err(ClipError::Fetch(format!("{url}: 404"))),
        };
        Ok(Page {
            bytes: fixture(name),
            content_type: Some(mime.into()),
        })
    }

    fn page() -> String {
        String::from_utf8(fixture("archive.html")).unwrap()
    }

    const PAGE_URL: &str = "https://example.com/articles/one";

    #[test]
    fn inlines_the_image_and_the_style_sheet() {
        let out = inline_page(&page(), PAGE_URL, &site).unwrap();
        assert!(
            out.contains("<img src=\"data:image/png;base64,iVBOR"),
            "{out}"
        );
        assert!(
            out.contains("<style>body { background: url(\"data:image/png;base64,"),
            "{out}"
        );
        assert!(out.contains("h1 { color: #036; }"));
        assert!(!out.contains("<link"), "{out}");
        assert!(!out.contains("srcset"));
        assert!(!out.contains("pic.png"));
        assert!(out.contains("<h1>Archive Page</h1>"));
    }

    #[test]
    fn drops_scripts_and_keeps_missing_assets_as_absolute_links() {
        let out = inline_page(&page(), PAGE_URL, &site).unwrap();
        assert!(!out.contains("<script") && !out.contains("alert") && !out.contains("app.js"));
        assert!(
            out.contains("src=\"https://cdn.test/missing.png\""),
            "{out}"
        );
    }

    #[test]
    fn the_file_declares_utf8_first() {
        let out = inline_page(&page(), PAGE_URL, &site).unwrap();
        assert!(
            out.contains("<head><meta charset=\"utf-8\">\n<meta charset=\"utf-8\">"),
            "{out}"
        );
        assert_eq!(
            inline_page("<p>plain</p>", PAGE_URL, &site).unwrap(),
            "<meta charset=\"utf-8\"><p>plain</p>"
        );
    }

    #[test]
    fn active_content_is_removed() {
        let html = "<body onload=\"x()\"><img src=\"a.png\" onerror=\"x()\">\
                    <a href=\"JavaScript:x()\" title=t>l</a><iframe src=f></iframe>\
                    <meta http-equiv=refresh content=\"0;url=//e\"><p>ok</p>";
        let out = inline_page(html, PAGE_URL, &site).unwrap();
        for bad in ["onload", "onerror", "avascript", "<iframe", "http-equiv"] {
            assert!(!out.contains(bad), "{bad}: {out}");
        }
        assert!(
            out.contains("<a title=\"t\">l</a>") && out.contains("<p>ok</p>"),
            "{out}"
        );
    }

    #[test]
    fn a_script_in_a_comment_or_unclosed_keeps_the_page() {
        let out = inline_page("<!-- <script src=a.js> --><p>content</p>", PAGE_URL, &site).unwrap();
        assert!(out.contains("<p>content</p>"), "{out}");
        let out = inline_page("<script src=a.js><p>content</p>", PAGE_URL, &site).unwrap();
        assert!(
            out.contains("<p>content</p>") && !out.contains("<script"),
            "{out}"
        );
    }

    #[test]
    fn media_is_kept_and_alternate_sheets_are_not_applied() {
        let html = "<link rel=stylesheet media=print href=/static/site.css>\
                    <link rel=\"alternate stylesheet\" href=/static/site.css>";
        let out = inline_page(html, PAGE_URL, &site).unwrap();
        assert!(out.contains("<style media=\"print\">"), "{out}");
        assert_eq!(out.matches("<style").count(), 1, "{out}");
    }

    #[test]
    fn style_attributes_and_elements_are_inlined() {
        let html = "<head><style>p { background: url(img/pic.png) }</style></head>\
                    <div style=\"background:url('img/pic.png')\">x</div>";
        let out = inline_page(html, PAGE_URL, &site).unwrap();
        assert_eq!(out.matches("data:image/png;base64,").count(), 2, "{out}");
        assert!(!out.contains("img/pic.png"));
    }

    #[test]
    fn a_greater_than_in_an_attribute_does_not_end_the_tag() {
        let html = "<img alt=\"a > b\" src=\"img/pic.png\"><p>after</p>";
        let out = inline_page(html, PAGE_URL, &site).unwrap();
        assert!(out.contains("alt=\"a > b\""), "{out}");
        assert!(out.contains("<p>after</p>"));
    }

    #[test]
    fn assets_over_the_limits_stay_links() {
        let big = |_: &str| {
            Ok(Page {
                bytes: vec![0; MAX_ASSET_BYTES + 1],
                content_type: Some("image/png".into()),
            })
        };
        let out = inline_page("<img src=\"a.png\">", PAGE_URL, &big).unwrap();
        assert!(
            out.ends_with("<img src=\"https://example.com/articles/a.png\">"),
            "{out}"
        );

        // An asset of 2 MiB is 2.7 MiB as base64: three fit, the fourth does not.
        let two_mib = |_: &str| {
            Ok(Page {
                bytes: vec![0; MAX_ASSET_BYTES],
                content_type: Some("image/png".into()),
            })
        };
        let html = "<img src=\"a.png\">".repeat(6);
        let out = inline_page(&html, PAGE_URL, &two_mib).unwrap();
        assert_eq!(out.matches("data:image/png").count(), 3);
        assert!(out.len() <= MAX_ARCHIVE_BYTES);
    }

    #[test]
    fn a_page_over_the_limit_is_refused() {
        let html = "x".repeat(MAX_ARCHIVE_BYTES + 1);
        assert!(inline_page(&html, PAGE_URL, &site).is_err());
    }

    #[test]
    fn every_asset_is_fetched_once_at_most_per_reference() {
        let seen = RefCell::new(Vec::new());
        let spy = |url: &str| {
            seen.borrow_mut().push(url.to_string());
            site(url)
        };
        inline_page(&page(), PAGE_URL, &spy).unwrap();
        let seen = seen.into_inner();
        assert!(seen.contains(&"https://example.com/static/site.css".to_string()));
        assert!(!seen.iter().any(|u| u.contains("app.js")), "{seen:?}");
    }

    #[test]
    fn mime_comes_from_the_header_then_the_extension() {
        assert_eq!(
            mime_of("https://x.test/a.png", Some("image/webp; q=1")),
            "image/webp"
        );
        assert_eq!(
            mime_of("https://x.test/a.svg?v=1", Some("text/html")),
            "image/svg+xml"
        );
        assert_eq!(
            mime_of("https://x.test/a", None),
            "application/octet-stream"
        );
    }
}
