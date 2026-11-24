//! Fetching a page for `nixe clip` and turning its bytes into text. The network sits behind
//! [`fetch`]; [`super::clip_with`] takes any function of that shape, so the tests use none.

use super::clip_impl::ClipError;

/// A page that does not answer within this time is not saved.
#[cfg(desktop)]
pub const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// A page is read only up to here; a larger one is cut off, not refused.
pub const MAX_PAGE_BYTES: u64 = 5 * 1024 * 1024;

/// The bytes of a page and the `Content-Type` header that came with them.
#[derive(Debug, Clone, Default)]
pub struct Page {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
}

/// What [`super::clip_with`] calls to get a page.
pub type Fetcher<'a> = &'a dyn Fn(&str) -> Result<Page, ClipError>;

#[cfg(desktop)]
pub fn fetch(url: &str) -> Result<Page, ClipError> {
    use std::io::Read;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(FETCH_TIMEOUT))
        .http_status_as_error(true)
        .build()
        .into();
    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| ClipError::Fetch(format!("{url}: {e}")))?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_PAGE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| ClipError::Fetch(format!("{url}: {e}")))?;
    Ok(Page {
        bytes,
        content_type,
    })
}

#[cfg(not(desktop))]
pub fn fetch(_url: &str) -> Result<Page, ClipError> {
    Err(ClipError::Fetch(
        "fetching a page is not available on this platform; pass the HTML".into(),
    ))
}

/// The value of `charset=` in a `Content-Type` header or a `<meta>` tag text.
fn charset_of(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let at = lower.find("charset")? + "charset".len();
    let rest = lower[at..].trim_start().strip_prefix('=')?.trim_start();
    let rest = rest.trim_start_matches(['"', '\'']);
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .collect();
    (!name.is_empty()).then_some(name)
}

/// The charset a page declares: the header wins, else a `<meta>` in the first kilobytes.
fn declared_charset(bytes: &[u8], content_type: Option<&str>) -> Option<String> {
    if let Some(cs) = content_type.and_then(charset_of) {
        return Some(cs);
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    let mut rest = head.as_str();
    while let Some(at) = rest.find("<meta") {
        let tag = &rest[at..];
        let end = tag.find('>').unwrap_or(tag.len());
        if let Some(cs) = charset_of(&tag[..end]) {
            return Some(cs);
        }
        rest = &tag[end.min(tag.len())..];
    }
    None
}

/// The bytes of windows-1252 from 0x80 to 0x9F (the rest equals ISO-8859-1).
const WINDOWS_1252: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
    '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
];

fn single_byte(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9f => WINDOWS_1252[usize::from(b - 0x80)],
            _ => char::from(b),
        })
        .collect()
}

/// The text of a page. UTF-8 (also with a BOM) is read as it is; a page that is not UTF-8 is
/// read as ISO-8859-1/windows-1252 when it declares that (or declares nothing and is not valid
/// UTF-8); any other declared charset is read as UTF-8 with replacement characters.
pub fn decode(bytes: &[u8], content_type: Option<&str>) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let declared = declared_charset(bytes, content_type);
    let latin = matches!(
        declared.as_deref(),
        Some(
            "iso-8859-1"
                | "iso8859-1"
                | "latin1"
                | "latin-1"
                | "windows-1252"
                | "cp1252"
                | "us-ascii"
                | "ascii"
                | "iso-8859-15"
        )
    );
    match std::str::from_utf8(bytes) {
        Ok(text) if !latin => text.to_string(),
        _ if latin => single_byte(bytes),
        Err(_) if declared.is_none() => single_byte(bytes),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_charset_of_header_and_meta() {
        assert_eq!(
            charset_of("text/html; charset=\"ISO-8859-1\"").as_deref(),
            Some("iso-8859-1")
        );
        assert_eq!(charset_of("text/html"), None);
        assert_eq!(
            declared_charset(b"<meta charset=utf-8>", Some("text/html")).as_deref(),
            Some("utf-8")
        );
        assert_eq!(
            declared_charset(b"<meta charset=latin1>", Some("text/html; charset=utf-8")).as_deref(),
            Some("utf-8")
        );
    }

    #[test]
    fn decodes_utf8_latin1_and_garbage() {
        assert_eq!(decode("Café".as_bytes(), None), "Café");
        assert_eq!(decode(b"\xEF\xBB\xBFabc", None), "abc");
        assert_eq!(
            decode(b"Caf\xe9 \x80", Some("text/html; charset=latin1")),
            "Café €"
        );
        // No declaration and not UTF-8: windows-1252 beats replacement characters.
        assert_eq!(decode(b"Caf\xe9", None), "Café");
        // Another declared charset that this build cannot read: no panic, no loss of ASCII.
        assert_eq!(
            decode(b"ab\xff", Some("text/html; charset=shift_jis")),
            "ab\u{fffd}"
        );
    }
}
