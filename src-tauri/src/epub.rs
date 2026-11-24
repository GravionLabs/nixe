//! Reading an `.epub` book for the reader (#486): the WebView never opens the file itself. The
//! backend returns the bytes of a book that lies in a root of the open workspace or in the vault.

use std::fs;
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Largest book that is returned. A book is 1 to 20 MB; this leaves room for an illustrated one.
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;

/// The bytes of the book `path`. The file must be a regular `.epub` file whose canonical path
/// (symlinks resolved, so a link cannot lead out) lies below one of `roots`.
pub fn read_epub(roots: &[PathBuf], path: &Path) -> Result<Vec<u8>, String> {
    let is_epub = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("epub"));
    if !is_epub {
        return Err(format!("not an EPUB file: {}", path.display()));
    }
    let real = dunce::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let inside = roots
        .iter()
        .filter_map(|r| dunce::canonicalize(r).ok())
        .any(|r| real.starts_with(r));
    if !inside {
        return Err(format!(
            "outside the open roots and the vault: {}",
            path.display()
        ));
    }
    let file = fs::File::open(&real).map_err(|e| format!("{}: {e}", path.display()))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    let too_large = || {
        format!(
            "book too large (limit {} MB): {}",
            MAX_BYTES / 1024 / 1024,
            path.display()
        )
    };
    if meta.len() > MAX_BYTES {
        return Err(too_large());
    }
    // The file may grow between the check and the read: never take more than the limit.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

/// Time a download may take in total.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// Fixed 64-bit FNV-1a, so the name of a downloaded book stays the same across Rust versions.
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf29ce484222325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    })
}

/// True for `https://host/…` and nothing else (no whitespace, a host).
pub fn is_https_url(url: &str) -> bool {
    let t = url.trim();
    t.len() > "https://".len()
        && t.get(..8)
            .is_some_and(|p| p.eq_ignore_ascii_case("https://"))
        && !t.chars().any(char::is_whitespace)
}

/// The file name of the book of `url` in the books folder: the last path segment (letters, digits,
/// `-`, `_`, `.`) and a hash of the whole URL, so two URLs never share a file.
fn book_file_name(url: &str) -> String {
    let no_query = url.split(['?', '#']).next().unwrap_or(url);
    let last = no_query.rsplit('/').next().unwrap_or("");
    let stem = last
        .strip_suffix(".epub")
        .or_else(|| last.strip_suffix(".EPUB"))
        .unwrap_or(last);
    let mut clean: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '_'
            }
        })
        .take(60)
        .collect();
    clean = clean.trim_matches('.').to_string();
    if clean.is_empty() {
        clean = "book".into();
    }
    format!("{clean}-{:016x}.epub", fnv1a(url))
}

/// A real EPUB is a ZIP whose first entry is the stored `mimetype` file.
fn looks_like_epub(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(256)];
    head.starts_with(b"PK\x03\x04")
        && head
            .windows(b"application/epub+zip".len())
            .any(|w| w == b"application/epub+zip")
}

/// Downloads the book at `url` into `books_dir` and returns its path. A book that was downloaded
/// before is returned without a request. Only `https` is accepted (also for redirects); a body over
/// `max` bytes or one that is no EPUB is refused and leaves no file. The file is written to a
/// temporary name and renamed, so a half-finished download is never taken for a book.
pub fn download_epub(books_dir: &Path, url: &str, max: u64) -> Result<PathBuf, String> {
    if !is_https_url(url) {
        return Err(format!("only https URLs are downloaded: {url}"));
    }
    fetch_epub(books_dir, url.trim(), max, true, DOWNLOAD_TIMEOUT)
}

fn fetch_epub(
    books_dir: &Path,
    url: &str,
    max: u64,
    https_only: bool,
    timeout: Duration,
) -> Result<PathBuf, String> {
    let target = books_dir.join(book_file_name(url));
    if target.is_file() {
        return Ok(target);
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .https_only(https_only)
        .http_status_as_error(true)
        .build()
        .into();
    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| format!("download failed: {url}: {e}"))?;
    let too_large = || format!("book too large (limit {} MB): {url}", max / 1024 / 1024);
    let declared = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > max) {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("download failed: {url}: {e}"))?;
    if bytes.len() as u64 > max {
        return Err(too_large());
    }
    if !looks_like_epub(&bytes) {
        return Err(format!("not an EPUB file: {url}"));
    }
    fs::create_dir_all(books_dir).map_err(|e| format!("{}: {e}", books_dir.display()))?;
    let tmp = books_dir.join(format!(".{}.part", book_file_name(url)));
    let write = fs::File::create(&tmp)
        .and_then(|mut f| f.write_all(&bytes).and_then(|()| f.sync_all()))
        .and_then(|()| fs::rename(&tmp, &target));
    if let Err(e) = write {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {e}", target.display()));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-epub-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        dunce::canonicalize(p).unwrap()
    }

    #[test]
    fn returns_a_book_in_a_root() {
        let base = tmp("ok");
        fs::create_dir_all(base.join("root/books")).unwrap();
        fs::write(base.join("root/books/a.epub"), b"PK book").unwrap();
        let got = read_epub(&[base.join("root")], &base.join("root/books/a.epub")).unwrap();
        assert_eq!(got, b"PK book");
    }

    #[test]
    fn accepts_any_of_several_roots_and_an_upper_case_extension() {
        let base = tmp("several");
        fs::create_dir_all(base.join("a")).unwrap();
        fs::create_dir_all(base.join("b")).unwrap();
        fs::write(base.join("b/x.EPUB"), b"x").unwrap();
        let roots = [base.join("a"), base.join("b")];
        assert_eq!(read_epub(&roots, &base.join("b/x.EPUB")).unwrap(), b"x");
    }

    #[test]
    fn refuses_a_file_outside_every_root() {
        let base = tmp("outside");
        fs::create_dir_all(base.join("root")).unwrap();
        fs::write(base.join("other.epub"), b"x").unwrap();
        let err = read_epub(&[base.join("root")], &base.join("other.epub")).unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert!(read_epub(&[], &base.join("other.epub")).is_err());
    }

    #[test]
    fn refuses_dot_dot_out_of_a_root() {
        let base = tmp("dotdot");
        fs::create_dir_all(base.join("root")).unwrap();
        fs::write(base.join("other.epub"), b"x").unwrap();
        let path = base.join("root/../other.epub");
        assert!(read_epub(&[base.join("root")], &path).is_err());
    }

    #[test]
    fn refuses_a_root_that_is_only_a_name_prefix() {
        let base = tmp("prefix");
        fs::create_dir_all(base.join("root")).unwrap();
        fs::create_dir_all(base.join("root-evil")).unwrap();
        fs::write(base.join("root-evil/a.epub"), b"x").unwrap();
        assert!(read_epub(&[base.join("root")], &base.join("root-evil/a.epub")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_out_of_a_root() {
        let base = tmp("symlink");
        fs::create_dir_all(base.join("root")).unwrap();
        fs::write(base.join("secret.epub"), b"secret").unwrap();
        std::os::unix::fs::symlink(base.join("secret.epub"), base.join("root/link.epub")).unwrap();
        let err = read_epub(&[base.join("root")], &base.join("root/link.epub")).unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_folder_symlink_out_of_a_root() {
        let base = tmp("dirlink");
        fs::create_dir_all(base.join("root")).unwrap();
        fs::create_dir_all(base.join("away")).unwrap();
        fs::write(base.join("away/a.epub"), b"x").unwrap();
        std::os::unix::fs::symlink(base.join("away"), base.join("root/dir")).unwrap();
        assert!(read_epub(&[base.join("root")], &base.join("root/dir/a.epub")).is_err());
    }

    #[test]
    fn refuses_a_file_over_the_limit() {
        let base = tmp("big");
        fs::create_dir_all(base.join("root")).unwrap();
        let file = fs::File::create(base.join("root/big.epub")).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap();
        let err = read_epub(&[base.join("root")], &base.join("root/big.epub")).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        // Exactly at the limit is still returned.
        let file = fs::File::create(base.join("root/edge.epub")).unwrap();
        file.set_len(MAX_BYTES).unwrap();
        let got = read_epub(&[base.join("root")], &base.join("root/edge.epub")).unwrap();
        assert_eq!(got.len() as u64, MAX_BYTES);
    }

    #[test]
    fn refuses_other_extensions_folders_and_missing_files() {
        let base = tmp("kinds");
        fs::create_dir_all(base.join("root/dir.epub")).unwrap();
        fs::write(base.join("root/a.txt"), b"x").unwrap();
        let roots = [base.join("root")];
        assert!(read_epub(&roots, &base.join("root/a.txt")).is_err());
        assert!(read_epub(&roots, &base.join("root/dir.epub")).is_err());
        assert!(read_epub(&roots, &base.join("root/missing.epub")).is_err());
    }

    // --- download (#491) ---

    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn epub_bytes() -> Vec<u8> {
        let mut b = b"PK\x03\x04".to_vec();
        b.extend_from_slice(&[0; 26]);
        b.extend_from_slice(b"mimetypeapplication/epub+zip");
        b.extend_from_slice(b" rest of the book");
        b
    }

    /// Serves `body` with `content_type` to every request; returns the base URL and the count.
    fn serve(body: Vec<u8>) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                counter.fetch_add(1, Ordering::SeqCst);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(&body);
            }
        });
        (format!("http://127.0.0.1:{port}"), hits)
    }

    const T: Duration = Duration::from_secs(5);

    #[test]
    fn downloads_once_and_reuses_the_file() {
        let dir = tmp("dl").join("books");
        let (base, hits) = serve(epub_bytes());
        let url = format!("{base}/a/Moby%20Dick.epub?x=1");
        let first = fetch_epub(&dir, &url, MAX_BYTES, false, T).unwrap();
        assert_eq!(fs::read(&first).unwrap(), epub_bytes());
        assert!(first.starts_with(&dir));
        assert!(first.extension().unwrap() == "epub");
        let second = fetch_epub(&dir, &url, MAX_BYTES, false, T).unwrap();
        assert_eq!(first, second);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        // No temporary file is left behind.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        // Another URL is another file.
        let other = fetch_epub(
            &dir,
            &format!("{base}/b/Moby%20Dick.epub"),
            MAX_BYTES,
            false,
            T,
        )
        .unwrap();
        assert_ne!(first, other);
    }

    #[test]
    fn the_sample_book_passes_the_epub_check() {
        let book = fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/books/sample.epub"
        ))
        .unwrap();
        assert!(looks_like_epub(&book));
        assert!(!looks_like_epub(b"PK\x03\x04"));
    }

    #[test]
    fn refuses_a_download_over_the_limit() {
        let dir = tmp("dl-big").join("books");
        let (base, _) = serve(epub_bytes());
        let err = fetch_epub(&dir, &format!("{base}/a.epub"), 10, false, T).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert!(!dir.exists() || fs::read_dir(&dir).unwrap().count() == 0);
    }

    #[test]
    fn refuses_a_response_that_is_no_epub() {
        let dir = tmp("dl-html").join("books");
        let (base, _) = serve(b"<html>not a book</html>".to_vec());
        let err = fetch_epub(&dir, &format!("{base}/a.epub"), MAX_BYTES, false, T).unwrap_err();
        assert!(err.contains("not an EPUB"), "{err}");
        // A ZIP that is no EPUB is refused as well.
        let (zip, _) = serve(b"PK\x03\x04 some other zip".to_vec());
        let err = fetch_epub(&dir, &format!("{zip}/b.epub"), MAX_BYTES, false, T).unwrap_err();
        assert!(err.contains("not an EPUB"), "{err}");
        assert!(!dir.exists() || fs::read_dir(&dir).unwrap().count() == 0);
    }

    #[test]
    fn refuses_urls_that_are_not_https() {
        let dir = tmp("dl-scheme").join("books");
        for url in [
            "http://example.com/a.epub",
            "ftp://example.com/a.epub",
            "file:///etc/passwd",
            "https://",
            "https://exa mple.com/a.epub",
            "",
        ] {
            let err = download_epub(&dir, url, MAX_BYTES).unwrap_err();
            assert!(err.contains("https"), "{url}: {err}");
        }
        assert!(!dir.exists());
    }

    #[test]
    fn a_plain_http_server_is_refused_by_the_public_entry() {
        let dir = tmp("dl-http").join("books");
        let (base, hits) = serve(epub_bytes());
        assert!(download_epub(&dir, &format!("{base}/a.epub"), MAX_BYTES).is_err());
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_failed_request_is_reported() {
        let dir = tmp("dl-fail").join("books");
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let err = fetch_epub(
            &dir,
            &format!("http://127.0.0.1:{port}/a.epub"),
            MAX_BYTES,
            false,
            T,
        )
        .unwrap_err();
        assert!(err.contains("download failed"), "{err}");
    }

    #[test]
    fn file_names_are_safe_and_distinct() {
        let a = book_file_name("https://x.org/../../etc/passwd.epub");
        assert!(!a.contains('/') && !a.starts_with('.'), "{a}");
        assert!(book_file_name("https://x.org/").starts_with("book-"));
        assert_ne!(
            book_file_name("https://x.org/a.epub"),
            book_file_name("https://y.org/a.epub")
        );
    }
}
