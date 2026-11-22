//! Sign in to a Git host through its CLI (#353). `GitProvider` is the seam; `GitHubCli` is the
//! one implementation and calls `gh`. The token is copied once into the keychain `TokenStore`.
//! It never goes to a log, a settings file, an error text or the webview.
//!
//! This module also holds the list of hosts that may receive a token: `github.com` plus the
//! GitHub Enterprise Server host the user configured.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, RwLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::credentials::{self, KeyringStore, TokenStore};

/// The public GitHub host; always allowed.
pub const GITHUB_HOST: &str = "github.com";
/// Event with the one-time code of a running web login (payload: the code as string).
pub const CODE_EVENT: &str = "git-provider-code";
/// Error text of a login the user cancelled.
pub const CANCELLED: &str = "cancelled";
/// Error text when `gh` is not installed.
pub const MISSING: &str = "The GitHub CLI (gh) is not installed. Install it from https://cli.github.com and try again, or enter a token.";

const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Configured hosts besides `github.com`, lower-case.
static EXTRA_HOSTS: RwLock<Vec<String>> = RwLock::new(Vec::new());
static CANCEL: AtomicBool = AtomicBool::new(false);

/// A host name as typed: letters, digits, `.`, `-`, optional `:port`. No scheme, path or user.
pub fn clean_host(host: &str) -> Option<String> {
    let host = host.trim().to_ascii_lowercase();
    let (name, port) = match host.split_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (host.as_str(), None),
    };
    let name_ok = !name.is_empty()
        && !name.starts_with(['.', '-'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    (name_ok && port_ok).then_some(host)
}

/// Replaces the configured extra hosts. Invalid entries are dropped.
pub fn set_extra_hosts(hosts: &[String]) {
    let list: Vec<String> = hosts
        .iter()
        .filter_map(|h| clean_host(h))
        .filter(|h| h != GITHUB_HOST)
        .collect();
    *EXTRA_HOSTS.write().unwrap() = list;
}

/// True when `host` is github.com or a configured host.
pub fn host_allowed(host: &str) -> bool {
    host == GITHUB_HOST || EXTRA_HOSTS.read().unwrap().iter().any(|h| h == host)
}

/// True for a plain `https://<allowed host>/...` URL without user info, whitespace or control
/// characters. Only such URLs may ever receive a token.
pub fn is_allowed_https(url: &str) -> bool {
    let Some(host) = credentials::host_of(url) else {
        return false;
    };
    let rest = &url["https://".len()..];
    let path = &rest[rest.find(['/', '?', '#']).unwrap_or(rest.len())..];
    host_allowed(&host)
        && path.len() > 1
        && !url.contains('@')
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The hosts the webview may sign in to (command checks `host_allowed`).
#[tauri::command]
pub fn git_set_hosts(hosts: Vec<String>) {
    set_extra_hosts(&hosts);
}

/// A way to get a token for one host from a local tool.
pub trait GitProvider {
    // Part of the contract for providers added later; nothing reads it yet.
    #[allow(dead_code)]
    fn id(&self) -> &str;
    fn host(&self) -> &str;
    fn is_available(&self) -> bool;
    /// Runs the interactive login; `on_code` gets the one-time code to show. `cancel` becomes true
    /// when the user gives up.
    fn login(&self, on_code: &mut dyn FnMut(&str), cancel: &AtomicBool) -> Result<(), String>;
    /// The token of a signed-in host; `None` when signed out.
    fn token(&self) -> Result<Option<String>, String>;
}

/// The calls to `gh`, behind a trait so tests use a fake.
pub trait GhRunner {
    fn available(&self) -> bool;
    /// Stdout of `gh auth token --hostname <host>`; `None` when it failed (signed out).
    fn auth_token(&self, host: &str) -> Option<String>;
    /// `gh auth login --hostname <host> --web --git-protocol https`.
    fn auth_login(
        &self,
        host: &str,
        on_code: &mut dyn FnMut(&str),
        cancel: &AtomicBool,
    ) -> Result<(), String>;
}

/// The real `gh`.
pub struct GhCommand;

/// The one-time code in a line of `gh`: `XXXX-XXXX`.
fn find_code(line: &str) -> Option<String> {
    line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .find(|w| {
            w.len() == 9
                && w.as_bytes()[4] == b'-'
                && w.bytes()
                    .enumerate()
                    .all(|(i, b)| i == 4 || b.is_ascii_alphanumeric())
        })
        .map(str::to_owned)
}

impl GhRunner for GhCommand {
    fn available(&self) -> bool {
        Command::new("gh")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn auth_token(&self, host: &str) -> Option<String> {
        let out = Command::new("gh")
            .args(["auth", "token", "--hostname", host])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let token = String::from_utf8(out.stdout).ok()?.trim().to_owned();
        (!token.is_empty()).then_some(token)
    }

    fn auth_login(
        &self,
        host: &str,
        on_code: &mut dyn FnMut(&str),
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let mut child = Command::new("gh")
            .args([
                "auth",
                "login",
                "--hostname",
                host,
                "--web",
                "--git-protocol",
                "https",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "the GitHub CLI could not be started".to_owned())?;
        let (tx, rx) = mpsc::channel::<String>();
        if let Some(out) = child.stdout.take() {
            let tx = tx.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    let _ = tx.send(line);
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            let tx = tx.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    let _ = tx.send(line);
                }
            });
        }
        drop(tx);
        let mut stdin = child.stdin.take();
        let started = Instant::now();
        let mut shown = false;
        let outcome = loop {
            if cancel.load(Ordering::SeqCst) {
                break Err(CANCELLED.to_owned());
            }
            if started.elapsed() > LOGIN_TIMEOUT {
                break Err("the sign-in took too long".to_owned());
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    if !shown {
                        if let Some(code) = find_code(&line) {
                            on_code(&code);
                            shown = true;
                            // `gh` waits for Enter before it opens the browser.
                            if let Some(s) = stdin.as_mut() {
                                let _ = s.write_all(b"\n");
                                let _ = s.flush();
                            }
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break match child.wait() {
                        Ok(s) if s.success() => Ok(()),
                        _ => Err("the GitHub CLI sign-in failed".to_owned()),
                    };
                }
            }
            // A browser that `gh` started can keep the pipes open after `gh` is done.
            match child.try_wait() {
                Ok(Some(s)) if s.success() => break Ok(()),
                Ok(Some(_)) => break Err("the GitHub CLI sign-in failed".to_owned()),
                _ => {}
            }
        };
        if outcome.is_err() {
            let _ = child.kill();
        }
        let _ = child.wait();
        // The reader threads end by themselves when the pipes close; never wait for them.
        outcome
    }
}

/// GitHub (or GitHub Enterprise Server) through `gh`.
pub struct GitHubCli<R: GhRunner> {
    host: String,
    runner: R,
}

impl<R: GhRunner> GitHubCli<R> {
    pub fn new(host: &str, runner: R) -> Self {
        Self {
            host: host.to_owned(),
            runner,
        }
    }
}

impl<R: GhRunner> GitProvider for GitHubCli<R> {
    fn id(&self) -> &str {
        "github-cli"
    }

    fn host(&self) -> &str {
        &self.host
    }

    fn is_available(&self) -> bool {
        self.runner.available()
    }

    fn login(&self, on_code: &mut dyn FnMut(&str), cancel: &AtomicBool) -> Result<(), String> {
        self.runner.auth_login(&self.host, on_code, cancel)
    }

    fn token(&self) -> Result<Option<String>, String> {
        Ok(self.runner.auth_token(&self.host))
    }
}

/// What `sign_in` did: the token of an already signed-in provider was copied, or the web login ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignInOutcome {
    TakenOver,
    LoggedIn,
}

/// Gets the token of the provider (running the web login when signed out) and stores it for
/// the provider's host. Nothing is stored when the login fails or is cancelled.
pub fn sign_in(
    provider: &dyn GitProvider,
    store: &dyn TokenStore,
    on_code: &mut dyn FnMut(&str),
    cancel: &AtomicBool,
) -> Result<SignInOutcome, String> {
    if !host_allowed(provider.host()) {
        return Err("this host is not configured".into());
    }
    if !provider.is_available() {
        return Err(MISSING.into());
    }
    let (token, outcome) = match provider.token()? {
        Some(t) => (t, SignInOutcome::TakenOver),
        None => {
            provider.login(on_code, cancel)?;
            if cancel.load(Ordering::SeqCst) {
                return Err(CANCELLED.into());
            }
            let token = provider
                .token()?
                .ok_or("the GitHub CLI gave no token after the sign-in")?;
            (token, SignInOutcome::LoggedIn)
        }
    };
    store.set(provider.host(), &token)?;
    Ok(outcome)
}

/// Whether `gh` is installed.
#[tauri::command]
pub async fn git_provider_available() -> bool {
    tauri::async_runtime::spawn_blocking(|| GhCommand.available())
        .await
        .unwrap_or(false)
}

/// Signs in to `host` through `gh` and stores the token in the keychain. The one-time code of a
/// web login comes as `CODE_EVENT`. Returns `taken-over` (the token of a signed-in `gh` was copied) or `logged-in`. Errors: `cancelled`, or a plain message.
#[tauri::command]
pub async fn git_provider_login(app: AppHandle, host: String) -> Result<SignInOutcome, String> {
    let host = clean_host(&host).ok_or("invalid host")?;
    CANCEL.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let provider = GitHubCli::new(&host, GhCommand);
        let mut emit = |code: &str| {
            let _ = app.emit(CODE_EVENT, code.to_owned());
        };
        sign_in(&provider, &KeyringStore, &mut emit, &CANCEL)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Gives up the running web login.
#[tauri::command]
pub fn git_provider_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) static HOSTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryStore;
    use std::cell::{Cell, RefCell};

    struct Fake {
        installed: bool,
        token: RefCell<Option<String>>,
        /// What a login does: set the token, or fail with this text.
        login: Result<&'static str, &'static str>,
        logins: Cell<u32>,
    }

    impl Fake {
        fn new(
            installed: bool,
            token: Option<&str>,
            login: Result<&'static str, &'static str>,
        ) -> Self {
            Self {
                installed,
                token: RefCell::new(token.map(str::to_owned)),
                login,
                logins: Cell::new(0),
            }
        }
    }

    impl GhRunner for &Fake {
        fn available(&self) -> bool {
            self.installed
        }
        fn auth_token(&self, _host: &str) -> Option<String> {
            self.token.borrow().clone()
        }
        fn auth_login(
            &self,
            _host: &str,
            on_code: &mut dyn FnMut(&str),
            _cancel: &AtomicBool,
        ) -> Result<(), String> {
            self.logins.set(self.logins.get() + 1);
            on_code("ABCD-1234");
            match self.login {
                Ok(t) => {
                    *self.token.borrow_mut() = Some(t.to_owned());
                    Ok(())
                }
                Err(e) => Err(e.to_owned()),
            }
        }
    }

    fn run(fake: &Fake, store: &MemoryStore) -> (Result<SignInOutcome, String>, Vec<String>) {
        let provider = GitHubCli::new("github.com", fake);
        let mut codes = Vec::new();
        let result = sign_in(
            &provider,
            store,
            &mut |c| codes.push(c.to_owned()),
            &AtomicBool::new(false),
        );
        (result, codes)
    }

    #[test]
    fn a_signed_in_gh_gives_its_token_without_a_login() {
        let fake = Fake::new(true, Some("tok"), Err("unused"));
        let store = MemoryStore::default();
        let (result, codes) = run(&fake, &store);
        assert_eq!(result, Ok(SignInOutcome::TakenOver));
        assert!(codes.is_empty());
        assert_eq!(fake.logins.get(), 0);
        assert_eq!(store.get("github.com").unwrap().as_deref(), Some("tok"));
    }

    #[test]
    fn a_signed_out_gh_runs_the_login_and_shows_the_code() {
        let fake = Fake::new(true, None, Ok("fresh"));
        let store = MemoryStore::default();
        let (result, codes) = run(&fake, &store);
        assert_eq!(result, Ok(SignInOutcome::LoggedIn));
        assert_eq!(codes, vec!["ABCD-1234"]);
        assert_eq!(store.get("github.com").unwrap().as_deref(), Some("fresh"));
    }

    #[test]
    fn the_outcome_is_serialized_as_its_kebab_case_name() {
        assert_eq!(
            serde_json::to_string(&SignInOutcome::TakenOver).unwrap(),
            "\"taken-over\""
        );
        assert_eq!(
            serde_json::to_string(&SignInOutcome::LoggedIn).unwrap(),
            "\"logged-in\""
        );
    }

    #[test]
    fn a_cancelled_login_stores_nothing() {
        let fake = Fake::new(true, None, Err(CANCELLED));
        let store = MemoryStore::default();
        let (result, _) = run(&fake, &store);
        assert_eq!(result, Err("cancelled".to_owned()));
        assert_eq!(store.get("github.com").unwrap(), None);
    }

    #[test]
    fn a_login_that_ends_without_a_token_stores_nothing() {
        struct NoToken;
        impl GhRunner for NoToken {
            fn available(&self) -> bool {
                true
            }
            fn auth_token(&self, _: &str) -> Option<String> {
                None
            }
            fn auth_login(
                &self,
                _: &str,
                _: &mut dyn FnMut(&str),
                _: &AtomicBool,
            ) -> Result<(), String> {
                Ok(())
            }
        }
        let store = MemoryStore::default();
        let provider = GitHubCli::new("github.com", NoToken);
        let result = sign_in(&provider, &store, &mut |_| {}, &AtomicBool::new(false));
        assert!(result.is_err());
        assert_eq!(store.get("github.com").unwrap(), None);
    }

    #[test]
    fn a_missing_gh_explains_how_to_install_it() {
        let fake = Fake::new(false, None, Err("unused"));
        let store = MemoryStore::default();
        let (result, _) = run(&fake, &store);
        let message = result.unwrap_err();
        assert!(message.contains("https://cli.github.com"));
        assert_eq!(fake.logins.get(), 0);
        assert_eq!(store.get("github.com").unwrap(), None);
    }

    #[test]
    fn the_token_is_not_in_an_error_text() {
        let fake = Fake::new(true, Some("s3cret"), Err("unused"));
        struct Failing;
        impl TokenStore for Failing {
            fn get(&self, _: &str) -> Result<Option<String>, String> {
                Ok(None)
            }
            fn set(&self, _: &str, _: &str) -> Result<(), String> {
                Err("keychain locked".into())
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                Ok(())
            }
        }
        let provider = GitHubCli::new("github.com", &fake);
        let err = sign_in(&provider, &Failing, &mut |_| {}, &AtomicBool::new(false)).unwrap_err();
        assert!(!err.contains("s3cret"));
    }

    #[test]
    fn an_unconfigured_host_is_refused_and_a_configured_one_works() {
        let _guard = HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_extra_hosts(&[]);
        let fake = Fake::new(true, Some("tok"), Err("unused"));
        let store = MemoryStore::default();
        let provider = GitHubCli::new("ghe.example.com", &fake);
        assert!(sign_in(&provider, &store, &mut |_| {}, &AtomicBool::new(false)).is_err());
        assert_eq!(store.get("ghe.example.com").unwrap(), None);
        set_extra_hosts(&["GHE.example.com".into()]);
        assert!(sign_in(&provider, &store, &mut |_| {}, &AtomicBool::new(false)).is_ok());
        assert_eq!(
            store.get("ghe.example.com").unwrap().as_deref(),
            Some("tok")
        );
        set_extra_hosts(&[]);
    }

    #[test]
    fn the_allow_list_decides_which_urls_get_a_token() {
        let _guard = HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_extra_hosts(&[
            "ghe.example.com".into(),
            "bad host".into(),
            "github.com".into(),
        ]);
        assert!(is_allowed_https("https://github.com/a/b.git"));
        assert!(is_allowed_https("https://ghe.example.com/a/b.git"));
        assert!(!is_allowed_https("https://ghe.example.com:8443/a"));
        assert!(!is_allowed_https("https://evil.example.com/a/b.git"));
        assert!(!is_allowed_https("https://ghe.example.com.evil.com/a"));
        assert!(!is_allowed_https("https://ghe.example.com@evil.com/a"));
        assert!(!is_allowed_https("https://user:pw@ghe.example.com/a"));
        assert!(!is_allowed_https("http://ghe.example.com/a"));
        assert!(!is_allowed_https("https://github.com/"));
        assert!(!is_allowed_https("https://github.com/a b"));
        set_extra_hosts(&[]);
        assert!(!is_allowed_https("https://ghe.example.com/a/b.git"));
    }

    #[test]
    fn the_provider_names_itself_and_its_host() {
        let fake = Fake::new(true, None, Err("unused"));
        let provider = GitHubCli::new("github.com", &fake);
        assert_eq!(provider.id(), "github-cli");
        assert_eq!(provider.host(), "github.com");
    }

    #[test]
    fn hosts_are_cleaned() {
        assert_eq!(
            clean_host(" GHE.Example.com ").as_deref(),
            Some("ghe.example.com")
        );
        assert_eq!(
            clean_host("ghe.example.com:8443").as_deref(),
            Some("ghe.example.com:8443")
        );
        for bad in [
            "",
            "https://x.com",
            "x.com/a",
            "a@x.com",
            "x.com:",
            "-x.com",
            "x y",
        ] {
            assert_eq!(clean_host(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_code_is_found_in_the_gh_output() {
        assert_eq!(
            find_code("! First copy your one-time code: 1A2B-3C4D").as_deref(),
            Some("1A2B-3C4D")
        );
        assert_eq!(
            find_code("Press Enter to open github.com in your browser..."),
            None
        );
    }
}
