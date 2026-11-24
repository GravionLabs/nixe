//! The normal form of a link note's URL, so that one page saved twice is found again.

/// Query parameters that only track where a visitor came from; `utm_*` is matched by prefix.
pub const TRACKING_PARAMS: &[&str] = &["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "igshid"];

/// The prefix of the tracking parameters of the campaign kind (`utm_source`, `utm_medium`, …).
const TRACKING_PREFIX: &str = "utm_";

fn is_tracking(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.starts_with(TRACKING_PREFIX) || TRACKING_PARAMS.contains(&key.as_str())
}

/// Normalizes an `http(s)` URL: lowercase scheme and host, no default port, no fragment, no
/// trailing slash of the path, tracking parameters removed and the other ones sorted. Anything
/// that is not `scheme://…` comes back trimmed and otherwise unchanged.
pub fn normalize(url: &str) -> String {
    let url = url.trim();
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let scheme = scheme.to_ascii_lowercase();
    let rest = rest.split('#').next().unwrap_or_default();
    let (before_query, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (authority, path) = match before_query.find('/') {
        Some(i) => before_query.split_at(i),
        None => (before_query, ""),
    };

    let (user, hostport) = match authority.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, authority),
    };
    let hostport = hostport.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => ":80",
        "https" => ":443",
        _ => "",
    };
    let host = match hostport.strip_suffix(default_port) {
        Some(h) if !default_port.is_empty() => h,
        _ => hostport.strip_suffix(':').unwrap_or(&hostport),
    };

    let mut pairs: Vec<&str> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter(|pair| !is_tracking(pair.split('=').next().unwrap_or_default()))
        .collect();
    pairs.sort_unstable();

    let mut out = format!("{scheme}://");
    if let Some(user) = user {
        out.push_str(user);
        out.push('@');
    }
    out.push_str(host);
    out.push_str(path.trim_end_matches('/'));
    if !pairs.is_empty() {
        out.push('?');
        out.push_str(&pairs.join("&"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_that_are_the_same_page_match() {
        let same = [
            ("https://Example.COM/a", "https://example.com/a"),
            ("HTTPS://example.com/a", "https://example.com/a"),
            ("https://example.com:443/a", "https://example.com/a"),
            ("http://example.com:80/a", "http://example.com/a"),
            ("https://example.com", "https://example.com/"),
            ("https://example.com/a/", "https://example.com/a"),
            ("https://example.com/a#intro", "https://example.com/a"),
            (
                "https://example.com/a?b=2&a=1",
                "https://example.com/a?a=1&b=2",
            ),
            (
                "https://example.com/a?utm_source=x&id=7",
                "https://example.com/a?id=7",
            ),
            (
                "https://example.com/a?id=7&fbclid=abc",
                "https://example.com/a?id=7",
            ),
            (
                "https://example.com/a?gclid=1&mc_cid=2&mc_eid=3",
                "https://example.com/a",
            ),
            (
                "https://example.com/a?ref=home&igshid=9&UTM_Medium=m",
                "https://example.com/a",
            ),
            ("  https://example.com/a?  ", "https://example.com/a"),
            ("https://example.com:/a", "https://example.com/a"),
            (
                "https://example.com/a/?x=1#top",
                "https://example.com/a?x=1",
            ),
        ];
        for (a, b) in same {
            assert_eq!(normalize(a), normalize(b), "{a} vs {b}");
        }
        assert_eq!(
            normalize("HTTP://Example.com:80/A/?b=1&utm_x=1#f"),
            "http://example.com/A?b=1"
        );
    }

    #[test]
    fn urls_that_are_other_pages_do_not_match() {
        let different = [
            ("https://example.com/a", "https://example.com/b"),
            ("https://example.com/a", "https://example.com/A"),
            ("https://example.com/a", "http://example.com/a"),
            ("https://example.com/a", "https://www.example.com/a"),
            ("https://example.com:8080/a", "https://example.com/a"),
            ("https://example.com/a", "https://example.com:80/a"),
            ("https://example.com/a?id=1", "https://example.com/a?id=2"),
            ("https://example.com/a?id=1", "https://example.com/a"),
            ("https://example.com/a?reference=1", "https://example.com/a"),
            ("https://example.com/a?utm=1", "https://example.com/a"),
            ("https://example.com/a/b", "https://example.com/a"),
            ("https://u@example.com/a", "https://example.com/a"),
        ];
        for (a, b) in different {
            assert_ne!(normalize(a), normalize(b), "{a} vs {b}");
        }
    }

    #[test]
    fn something_that_is_no_url_is_only_trimmed() {
        assert_eq!(normalize(" example.com/a/ "), "example.com/a/");
    }
}
