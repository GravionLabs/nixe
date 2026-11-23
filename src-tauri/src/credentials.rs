//! The HTTPS access token for Git remotes (#74). It lives in the OS keychain (macOS
//! Keychain, Windows Credential Manager, Secret Service), one entry per remote host.
//! It never goes to the vault, a settings file or a log, and the webview can only store,
//! replace or delete it, never read it back.

// The helpers for remote operations are used by the spike module only, which a desktop release leaves out.
#![cfg_attr(not(any(debug_assertions, mobile)), allow(dead_code))]

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;

const KEYCHAIN_SERVICE: &str = "dev.nixe.app.git";

/// Error prefix: no token is stored for the host, ask for one.
pub const AUTH_REQUIRED: &str = "auth-required";
/// Error prefix: the server rejected the stored token, ask for a new one.
pub const AUTH_FAILED: &str = "auth-failed";

/// `<kind>:<host>`; the frontend recognizes both kinds and prompts for a token.
pub fn auth_error(kind: &str, host: &str) -> String {
    format!("{kind}:{host}")
}

/// Host of an `https://` url, lower-cased; `None` for anything else or a url with user info.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() || host.contains(['@', ' ']) {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// Storage of tokens by remote host.
pub trait TokenStore {
    fn get(&self, host: &str) -> Result<Option<String>, String>;
    fn set(&self, host: &str, token: &str) -> Result<(), String>;
    /// Deleting a token that is not stored succeeds.
    fn delete(&self, host: &str) -> Result<(), String>;
}

/// The OS keychain. Error texts come from `keyring` and never contain the token.
pub struct KeyringStore;

fn entry(host: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, host).map_err(|e| e.to_string())
}

impl TokenStore for KeyringStore {
    fn get(&self, host: &str) -> Result<Option<String>, String> {
        match entry(host)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, host: &str, token: &str) -> Result<(), String> {
        entry(host)?.set_password(token).map_err(|e| e.to_string())
    }

    fn delete(&self, host: &str) -> Result<(), String> {
        match entry(host)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// In-memory store for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

#[cfg(test)]
impl TokenStore for MemoryStore {
    fn get(&self, host: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(host).cloned())
    }

    fn set(&self, host: &str, token: &str) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(host.to_owned(), token.to_owned());
        Ok(())
    }

    fn delete(&self, host: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(host);
        Ok(())
    }
}

fn valid_host(host: &str) -> Result<String, String> {
    let host = host.trim().to_ascii_lowercase();
    let ok = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    if ok {
        Ok(host)
    } else {
        Err("invalid host".into())
    }
}

fn status(store: &dyn TokenStore, host: &str) -> Result<bool, String> {
    Ok(store.get(&valid_host(host)?)?.is_some())
}

fn replace(store: &dyn TokenStore, host: &str, token: &str) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("the token is empty".into());
    }
    let host = valid_host(host)?;
    match store.set(&host, token) {
        Ok(()) => {
            log::info!("token stored for {host}");
            Ok(())
        }
        Err(e) => {
            log::warn!("token not stored for {host}: {e}");
            Err(e)
        }
    }
}

fn remove(store: &dyn TokenStore, host: &str) -> Result<(), String> {
    let host = valid_host(host)?;
    store.delete(&host)?;
    log::info!("token removed for {host}");
    Ok(())
}

/// Whether a token is stored for `host`. The token itself never leaves the backend.
#[tauri::command]
pub fn git_token_status(host: String) -> Result<bool, String> {
    status(&KeyringStore, &host)
}

/// Stores or replaces the token of `host`.
#[tauri::command]
pub fn git_token_set(host: String, token: String) -> Result<(), String> {
    replace(&KeyringStore, &host, &token)
}

/// Removes the token of `host`.
#[tauri::command]
pub fn git_token_delete(host: String) -> Result<(), String> {
    remove(&KeyringStore, &host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_is_taken_from_the_url() {
        assert_eq!(
            host_of("https://GitHub.com/a/b.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(host_of("https://github.com").as_deref(), Some("github.com"));
        for url in [
            "http://github.com/a",
            "file:///x",
            "https://u:p@github.com/a",
            "https:///a",
            "",
        ] {
            assert_eq!(host_of(url), None, "{url}");
        }
    }

    #[test]
    fn tokens_are_kept_per_host() {
        let store = MemoryStore::default();
        assert!(!status(&store, "github.com").unwrap());
        replace(&store, "github.com", "  t1 ").unwrap();
        assert!(status(&store, "GitHub.com").unwrap());
        assert!(!status(&store, "gitlab.com").unwrap());
        assert_eq!(store.get("github.com").unwrap().as_deref(), Some("t1"));
    }

    #[test]
    fn a_token_can_be_replaced_and_deleted() {
        let store = MemoryStore::default();
        replace(&store, "github.com", "old").unwrap();
        replace(&store, "github.com", "new").unwrap();
        assert_eq!(store.get("github.com").unwrap().as_deref(), Some("new"));
        remove(&store, "github.com").unwrap();
        assert!(!status(&store, "github.com").unwrap());
        remove(&store, "github.com").unwrap();
    }

    #[test]
    fn empty_token_and_bad_host_are_refused() {
        let store = MemoryStore::default();
        assert!(replace(&store, "github.com", "  ").is_err());
        assert!(replace(&store, "", "t").is_err());
        assert!(replace(&store, "a/b", "t").is_err());
        assert!(status(&store, "x y").is_err());
    }

    #[test]
    fn a_token_and_a_password_never_reach_the_log() {
        use crate::logging::capture;
        capture::install();
        struct Locked;
        impl TokenStore for Locked {
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
        let store = MemoryStore::default();
        replace(&store, "tok.example.com", "ghp_t410token").unwrap();
        remove(&store, "tok.example.com").unwrap();
        replace(&Locked, "locked.example.com", "ghp_t410password").unwrap_err();
        // A bad host is refused with a fixed text, so a pasted secret in its place stays out.
        replace(&store, "hunter2-t410/secret", "ghp_t410other").unwrap_err();
        crate::logging::command_failed(
            "git_token_set",
            &replace(&store, "hunter2-t410/secret", "t").unwrap_err(),
        );
        assert!(capture::contains("token stored for tok.example.com"));
        assert!(capture::contains("token removed for tok.example.com"));
        assert!(capture::contains(
            "token not stored for locked.example.com: keychain locked"
        ));
        for secret in [
            "ghp_t410token",
            "ghp_t410password",
            "ghp_t410other",
            "hunter2-t410",
        ] {
            assert!(!capture::contains(secret), "{secret} was logged");
        }
    }

    #[test]
    fn auth_errors_carry_kind_and_host() {
        assert_eq!(
            auth_error(AUTH_REQUIRED, "github.com"),
            "auth-required:github.com"
        );
    }
}
