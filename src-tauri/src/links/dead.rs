//! The opt-in dead link check (`nixe check --links`, the "Check links" button of the health
//! view): requests the `url` of every `type: link` note and reports the dead ones with the
//! closest Wayback Machine snapshot. Results are cached in the app data directory, never in the
//! vault; a link checked within [`CACHE_DAYS`] is not requested again unless forced.
//!
//! Dead means: HTTP 404 or 410, a DNS failure, or [`ATTEMPTS`] timeouts in a row. Every other
//! answer (also 5xx, a refused connection, a TLS error) is not dead: it may be a passing outage.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Duration as Days, FixedOffset};
use serde::{Deserialize, Serialize};

use crate::index::vault_hash;

/// Requests in flight at the same time.
pub const MAX_CONCURRENCY: usize = 4;
/// Minimum pause between two requests to the same host.
pub const HOST_DELAY: Duration = Duration::from_millis(1000);
/// Time limit of one request.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A link whose requests all time out this many times is dead.
pub const ATTEMPTS: usize = 3;
/// A cached result younger than this is used instead of a new request.
pub const CACHE_DAYS: i64 = 7;
/// The Wayback Machine availability API; the URL to look up is appended, percent-encoded.
pub const WAYBACK_API: &str = "https://archive.org/wayback/available?url=";

/// What one request found out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    Status(u16),
    /// The host name does not resolve.
    NoHost,
    Timeout,
    /// Any other failure (refused connection, TLS error, bad URL).
    Failed,
}

/// The tunable parts of a run; [`Settings::default`] holds the constants.
#[derive(Debug, Clone)]
pub struct Settings {
    pub concurrency: usize,
    pub host_delay: Duration,
    pub timeout: Duration,
    pub wayback_api: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            concurrency: MAX_CONCURRENCY,
            host_delay: HOST_DELAY,
            timeout: REQUEST_TIMEOUT,
            wayback_api: WAYBACK_API.to_string(),
        }
    }
}

/// A `type: link` note and the address it saves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkNote {
    pub path: String,
    pub url: String,
}

/// The verdict for one URL, as cached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    /// RFC 3339 time of the check.
    pub checked: String,
    pub dead: bool,
    /// Why it is dead (`404`, `410`, `dns`, `timeout`); empty when alive.
    #[serde(default)]
    pub reason: String,
    /// The closest Wayback Machine snapshot of a dead link, when there is one.
    #[serde(default)]
    pub snapshot: Option<String>,
}

/// A dead link note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadLink {
    pub source: String,
    pub url: String,
    pub reason: String,
    pub snapshot: Option<String>,
    pub checked: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Cache {
    #[serde(default)]
    urls: HashMap<String, Verdict>,
}

/// `<app-data>/link-check/<vault-hash>.json` for the vault at `root`.
pub fn cache_path(app_data: &Path, root: &Path) -> PathBuf {
    app_data
        .join("link-check")
        .join(format!("{}.json", vault_hash(root)))
}

fn load_cache(path: &Path) -> Cache {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_cache(path: &Path, cache: &Cache) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(cache).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn is_fresh(v: &Verdict, now: DateTime<FixedOffset>) -> bool {
    DateTime::parse_from_rfc3339(&v.checked)
        .is_ok_and(|at| now.signed_duration_since(at) < Days::days(CACHE_DAYS))
}

/// The host of an `http(s)` URL, lower case; `None` for anything else.
fn host_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    (!host.is_empty()).then(|| host.to_lowercase())
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(desktop)]
fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into()
}

/// One request. `get` picks GET over HEAD.
#[cfg(desktop)]
fn probe(url: &str, get: bool, timeout: Duration) -> Probe {
    let agent = agent(timeout);
    let result = if get {
        agent.get(url).call()
    } else {
        agent.head(url).call()
    };
    match result {
        Ok(r) => Probe::Status(r.status().as_u16()),
        Err(ureq::Error::HostNotFound) => Probe::NoHost,
        Err(ureq::Error::Timeout(_)) => Probe::Timeout,
        Err(ureq::Error::Io(e)) if is_dns_failure(&e.to_string()) => Probe::NoHost,
        Err(_) => Probe::Failed,
    }
}

/// The resolver reports a missing host as an I/O error whose text differs per platform.
#[cfg(desktop)]
fn is_dns_failure(message: &str) -> bool {
    let message = message.to_lowercase();
    [
        "failed to lookup address",
        "name or service not known",
        "nodename nor servname",
        "no address associated",
        "no such host",
        "temporary failure in name resolution",
    ]
    .iter()
    .any(|m| message.contains(m))
}

#[cfg(not(desktop))]
fn probe(_url: &str, _get: bool, _timeout: Duration) -> Probe {
    Probe::Failed
}

#[cfg(desktop)]
fn fetch_text(url: &str, timeout: Duration) -> Option<String> {
    let mut response = agent(timeout).get(url).call().ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.body_mut().read_to_string().ok()
}

#[cfg(not(desktop))]
fn fetch_text(_url: &str, _timeout: Duration) -> Option<String> {
    None
}

/// The request, repeated up to [`ATTEMPTS`] times while it times out.
fn probe_retry(url: &str, get: bool, timeout: Duration) -> Probe {
    let mut last = Probe::Timeout;
    for _ in 0..ATTEMPTS {
        last = probe(url, get, timeout);
        if last != Probe::Timeout {
            break;
        }
    }
    last
}

/// HEAD, then GET when the server refuses HEAD (405, 403). `Some(reason)` when dead.
fn dead_reason(url: &str, timeout: Duration) -> Option<&'static str> {
    let mut result = probe_retry(url, false, timeout);
    if matches!(result, Probe::Status(405 | 403)) {
        result = probe_retry(url, true, timeout);
    }
    match result {
        Probe::Status(404) => Some("404"),
        Probe::Status(410) => Some("410"),
        Probe::NoHost => Some("dns"),
        Probe::Timeout => Some("timeout"),
        _ => None,
    }
}

/// The closest snapshot the Wayback availability API knows for `url`.
fn snapshot(url: &str, s: &Settings) -> Option<String> {
    let body = fetch_text(
        &format!("{}{}", s.wayback_api, percent_encode(url)),
        s.timeout,
    )?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let closest = json.get("archived_snapshots")?.get("closest")?;
    if closest.get("available")?.as_bool()? {
        closest.get("url")?.as_str().map(str::to_string)
    } else {
        None
    }
}

/// Waits so that requests to one host are at least `delay` apart.
struct HostGate {
    delay: Duration,
    next: Mutex<HashMap<String, Instant>>,
}

impl HostGate {
    fn wait(&self, host: &str) {
        let at = {
            let mut next = self.next.lock().unwrap();
            let now = Instant::now();
            let at = next.get(host).copied().unwrap_or(now).max(now);
            next.insert(host.to_string(), at + self.delay);
            at
        };
        if let Some(pause) = at.checked_duration_since(Instant::now()) {
            std::thread::sleep(pause);
        }
    }
}

/// Checks `urls` (each once) with at most `s.concurrency` requests at a time.
fn check_urls(
    urls: Vec<String>,
    s: &Settings,
    now: DateTime<FixedOffset>,
) -> Vec<(String, Verdict)> {
    let gate = HostGate {
        delay: s.host_delay,
        next: Mutex::new(HashMap::new()),
    };
    let queue = Mutex::new(VecDeque::from(urls));
    let done = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..s.concurrency.max(1) {
            scope.spawn(|| loop {
                let Some(url) = queue.lock().unwrap().pop_front() else {
                    break;
                };
                let reason = match host_of(&url) {
                    Some(host) => {
                        gate.wait(&host);
                        dead_reason(&url, s.timeout)
                    }
                    // Not an http(s) address: nothing to request.
                    None => None,
                };
                let snapshot = reason.and_then(|_| snapshot(&url, s));
                done.lock().unwrap().push((
                    url,
                    Verdict {
                        checked: now.to_rfc3339(),
                        dead: reason.is_some(),
                        reason: reason.unwrap_or_default().to_string(),
                        snapshot,
                    },
                ));
            });
        }
    });
    done.into_inner().unwrap()
}

/// The dead links among `notes`. A URL checked within [`CACHE_DAYS`] comes from the cache at
/// `cache` unless `force`; the others are requested and the cache is written again. The result
/// is sorted by note path.
pub fn check(
    notes: &[LinkNote],
    cache: &Path,
    force: bool,
    s: &Settings,
    now: DateTime<FixedOffset>,
) -> Result<Vec<DeadLink>, String> {
    let mut stored = load_cache(cache);
    let mut todo: Vec<String> = Vec::new();
    for note in notes {
        let fresh = !force && stored.urls.get(&note.url).is_some_and(|v| is_fresh(v, now));
        if !fresh && !todo.contains(&note.url) {
            todo.push(note.url.clone());
        }
    }
    if !todo.is_empty() {
        for (url, verdict) in check_urls(todo, s, now) {
            stored.urls.insert(url, verdict);
        }
        save_cache(cache, &stored)?;
    }
    let mut dead: Vec<DeadLink> = notes
        .iter()
        .filter_map(|n| {
            let v = stored.urls.get(&n.url).filter(|v| v.dead)?;
            Some(DeadLink {
                source: n.path.clone(),
                url: n.url.clone(),
                reason: v.reason.clone(),
                snapshot: v.snapshot.clone(),
                checked: v.checked.clone(),
            })
        })
        .collect();
    dead.sort_by(|a, b| a.source.cmp(&b.source));
    Ok(dead)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A local HTTP server: `/ok` 200, `/gone` 404, `/removed` 410, `/nohead` 405 for HEAD and
    /// 200 for GET, `/slow` never answers, `/wayback` answers the availability API.
    struct Server {
        base: String,
        hits: Arc<AtomicUsize>,
    }

    fn serve() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let snapshot_url = "http://web.archive.org/web/2020/https://gone.example/";
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counter.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut line = String::new();
                    BufReader::new(stream.try_clone().unwrap())
                        .read_line(&mut line)
                        .unwrap();
                    let mut parts = line.split_whitespace();
                    let (method, target) = (parts.next().unwrap(), parts.next().unwrap());
                    let (status, body) = match target.split('?').next().unwrap() {
                        "/ok" => ("200 OK", String::new()),
                        "/gone" => ("404 Not Found", String::new()),
                        "/removed" => ("410 Gone", String::new()),
                        "/nohead" if method == "HEAD" => ("405 Method Not Allowed", String::new()),
                        "/nohead" => ("200 OK", String::new()),
                        "/wayback" if target.contains("gone.example") => (
                            "200 OK",
                            format!(
                                r#"{{"archived_snapshots":{{"closest":{{"available":true,"url":"{snapshot_url}"}}}}}}"#
                            ),
                        ),
                        "/wayback" => ("200 OK", r#"{"archived_snapshots":{}}"#.to_string()),
                        "/slow" => {
                            std::thread::sleep(Duration::from_secs(3));
                            return;
                        }
                        _ => ("500 Internal Server Error", String::new()),
                    };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        if method == "HEAD" { 0 } else { body.len() },
                        if method == "HEAD" { "" } else { &body }
                    );
                });
            }
        });
        Server { base, hits }
    }

    fn settings(server: &Server) -> Settings {
        Settings {
            concurrency: 2,
            host_delay: Duration::from_millis(1),
            timeout: Duration::from_millis(150),
            wayback_api: format!("{}/wayback?url=", server.base),
        }
    }

    fn note(path: &str, url: String) -> LinkNote {
        LinkNote {
            path: path.into(),
            url,
        }
    }

    fn at(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).unwrap()
    }

    fn cache_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-dead-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("link-check").join("v.json")
    }

    #[test]
    fn alive_dead_and_timeout() {
        let server = serve();
        let notes = vec![
            note("a.md", format!("{}/ok", server.base)),
            note("b.md", format!("{}/gone", server.base)),
            note("c.md", format!("{}/removed", server.base)),
            note("d.md", format!("{}/slow", server.base)),
            note("e.md", format!("{}/nohead", server.base)),
            note("f.md", format!("{}/error", server.base)),
        ];
        let dead = check(
            &notes,
            &cache_file("kinds"),
            false,
            &settings(&server),
            at("2026-11-24T10:00:00+00:00"),
        )
        .unwrap();
        let found: Vec<(&str, &str)> = dead
            .iter()
            .map(|d| (d.source.as_str(), d.reason.as_str()))
            .collect();
        // 200, 405 then GET 200 and a 500 are not dead.
        assert_eq!(
            found,
            [("b.md", "404"), ("c.md", "410"), ("d.md", "timeout")]
        );
        assert_eq!(dead[0].snapshot, None);
    }

    #[test]
    fn dns_failure_is_dead_and_gets_a_snapshot() {
        let server = serve();
        let url = "http://gone.example.invalid/".to_string();
        let notes = vec![note("a.md", url.clone())];
        // The lookup of the snapshot answers for `gone.example`, which the encoded URL holds.
        let s = Settings {
            wayback_api: format!("{}/wayback?url=", server.base),
            ..settings(&server)
        };
        let dead = check(
            &notes,
            &cache_file("dns"),
            false,
            &s,
            at("2026-11-24T10:00:00+00:00"),
        )
        .unwrap();
        assert_eq!(dead.len(), 1);
        assert_eq!(dead[0].reason, "dns");
        assert_eq!(
            dead[0].snapshot.as_deref(),
            Some("http://web.archive.org/web/2020/https://gone.example/")
        );
    }

    #[test]
    fn cached_results_are_kept_for_seven_days_unless_forced() {
        let server = serve();
        let cache = cache_file("cache");
        let notes = vec![note("b.md", format!("{}/gone", server.base))];
        let s = settings(&server);
        let first = at("2026-11-24T10:00:00+00:00");
        check(&notes, &cache, false, &s, first).unwrap();
        // HEAD of the check plus the (empty) snapshot lookup.
        let after_first = server.hits.load(Ordering::SeqCst);
        assert_eq!(after_first, 2);

        let again = check(&notes, &cache, false, &s, at("2026-11-30T10:00:00+00:00")).unwrap();
        assert_eq!(server.hits.load(Ordering::SeqCst), after_first);
        assert_eq!(again[0].checked, first.to_rfc3339());

        check(&notes, &cache, false, &s, at("2026-12-01T10:00:01+00:00")).unwrap();
        assert_eq!(server.hits.load(Ordering::SeqCst), after_first * 2);

        check(&notes, &cache, true, &s, at("2026-12-01T10:00:02+00:00")).unwrap();
        assert_eq!(server.hits.load(Ordering::SeqCst), after_first * 3);
    }

    #[test]
    fn host_gate_spaces_requests_to_one_host() {
        let gate = HostGate {
            delay: Duration::from_millis(60),
            next: Mutex::new(HashMap::new()),
        };
        let start = Instant::now();
        gate.wait("a.example");
        gate.wait("a.example");
        gate.wait("b.example");
        assert!(start.elapsed() >= Duration::from_millis(60));
        assert!(start.elapsed() < Duration::from_millis(120));
    }

    #[test]
    fn helpers() {
        assert_eq!(
            host_of("https://User@Example.com:8080/a?b").as_deref(),
            Some("example.com:8080")
        );
        assert_eq!(host_of("ftp://x"), None);
        assert_eq!(
            percent_encode("https://a.b/c d"),
            "https%3A%2F%2Fa.b%2Fc%20d"
        );
    }
}
