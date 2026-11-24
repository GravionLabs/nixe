//! `nixe native-host`: the Native Messaging host of the browser extension (#513). The browser
//! starts it and talks to it over stdin/stdout: every message is a 32-bit length in native byte
//! order followed by that many bytes of UTF-8 JSON. Nothing but frames may go to stdout.
//!
//! Messages in:
//! - `{type: "clip", url, title?, html?, tags?, folder?, vault?}` saves a link note
//!   (like `nixe clip`) and answers `{ok: true, path, created, vault}`;
//! - `{type: "vaults"}` answers `{ok: true, vaults: [{name, path, folder, folders}]}`.
//!
//! Anything else answers `{ok: false, error}`. The host only writes into the vaults the app
//! knows (the folders of the saved workspaces) and only below their links folder: the page and
//! the extension are not trusted.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::cli::CliError;
use crate::links::{self, fetch, ClipRequest, DEFAULT_FOLDER};
use crate::vault::config::Config;
use crate::workspace::{self, Locations};

/// The name the browsers know the host by.
pub const HOST_NAME: &str = "app.gravionlabs.nixe";

/// Largest incoming message; a bigger one ends the conversation (it cannot be skipped safely).
pub const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

/// Chromium extension IDs (Chrome, Edge, Brave) that may start the host.
pub const ALLOWED_CHROMIUM_EXTENSIONS: &[&str] = &["nixeclipperextensionidplaceholder"];

/// The Firefox extension ID(s) that may start the host.
pub const ALLOWED_FIREFOX_EXTENSIONS: &[&str] = &["clipper@nixe.gravionlabs.app"];

const DESCRIPTION: &str = "Nixe: save the current page as a link note";

#[derive(Debug)]
pub enum FrameError {
    /// The announced length is over [`MAX_MESSAGE_BYTES`].
    TooLarge(usize),
    /// The stream ended inside a frame.
    Truncated,
    Io(io::Error),
}

/// Reads one frame. `Ok(None)` when the stream ends before the first byte of a frame (the
/// browser closed the port). Split reads are fine: the bytes are read until the frame is full.
pub fn read_frame(input: &mut dyn Read) -> Result<Option<Vec<u8>>, FrameError> {
    let mut len = [0u8; 4];
    let mut got = 0;
    while got < len.len() {
        match input.read(&mut len[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(FrameError::Truncated),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(FrameError::Io(e)),
        }
    }
    let len = u32::from_ne_bytes(len) as usize;
    if len > MAX_MESSAGE_BYTES {
        return Err(FrameError::TooLarge(len));
    }
    let mut body = vec![0u8; len];
    input.read_exact(&mut body).map_err(|e| match e.kind() {
        io::ErrorKind::UnexpectedEof => FrameError::Truncated,
        _ => FrameError::Io(e),
    })?;
    Ok(Some(body))
}

pub fn write_frame(out: &mut dyn Write, value: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(value).map_err(io::Error::other)?;
    let len = u32::try_from(body.len()).map_err(io::Error::other)?;
    out.write_all(&len.to_ne_bytes())?;
    out.write_all(&body)?;
    out.flush()
}

fn failure(error: impl std::fmt::Display) -> Value {
    json!({"ok": false, "error": error.to_string()})
}

/// A folder of a vault the host may write to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownVault {
    pub name: String,
    pub path: PathBuf,
}

/// The folders of the saved workspaces, each path once, the existing ones only.
pub fn known_vaults(app_data: &Path) -> Vec<KnownVault> {
    let locations = Locations::from_env().with_own(app_data);
    let mut out: Vec<KnownVault> = Vec::new();
    for name in workspace::list(app_data) {
        let Ok(ws) = workspace::load(app_data, &name, &locations) else {
            continue;
        };
        for root in ws.roots {
            let path = PathBuf::from(&root.path);
            if path.is_dir() && !out.iter().any(|v| v.path == path) {
                out.push(KnownVault {
                    name: root.name,
                    path,
                });
            }
        }
    }
    out
}

fn links_folder(root: &Path) -> String {
    Config::load(root)
        .links_folder()
        .unwrap_or_else(|| DEFAULT_FOLDER.to_string())
}

#[derive(Serialize)]
struct VaultInfo {
    name: String,
    path: String,
    /// The links folder, vault-relative.
    folder: String,
    /// Its sub folders (one level), vault-relative.
    folders: Vec<String>,
}

fn vaults_answer(vaults: &[KnownVault]) -> Value {
    let infos: Vec<VaultInfo> = vaults
        .iter()
        .map(|v| {
            let root = dunce::canonicalize(&v.path).unwrap_or_else(|_| v.path.clone());
            let folder = links_folder(&root);
            let mut folders: Vec<String> = std::fs::read_dir(root.join(&folder))
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| !n.starts_with('.'))
                .map(|n| format!("{folder}/{n}"))
                .collect();
            folders.sort_by_key(|n| n.to_lowercase());
            VaultInfo {
                name: v.name.clone(),
                path: crate::path_to_string(&v.path),
                folder,
                folders,
            }
        })
        .collect();
    json!({"ok": true, "vaults": infos})
}

fn text<'a>(msg: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match msg.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(format!("`{key}` must be a string")),
    }
}

fn pick<'a>(vaults: &'a [KnownVault], wanted: Option<&str>) -> Result<&'a KnownVault, String> {
    match wanted {
        None => vaults
            .first()
            .ok_or_else(|| "Nixe knows no vault yet: open a folder in a workspace first".into()),
        Some(w) => vaults
            .iter()
            .find(|v| v.name == w || crate::path_to_string(&v.path) == w)
            .ok_or_else(|| format!("{w}: not a vault of Nixe")),
    }
}

fn clip(msg: &Value, vaults: &[KnownVault], app_data: &Path) -> Result<Value, String> {
    let url = text(msg, "url")?.ok_or("`url` is missing")?.to_string();
    let title = text(msg, "title")?.filter(|t| !t.trim().is_empty());
    // Decoded like the file of `nixe clip --html`.
    let html = text(msg, "html")?
        .filter(|h| !h.is_empty())
        .map(|h| fetch::decode(h.as_bytes(), None));
    let tags = match msg.get("tags") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|t| t.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()
            .ok_or("`tags` must be a list of strings")?,
        Some(_) => return Err("`tags` must be a list of strings".into()),
    };
    let vault = pick(vaults, text(msg, "vault")?)?;
    let root = dunce::canonicalize(&vault.path).map_err(|e| format!("{}: {e}", vault.name))?;
    let folder = match text(msg, "folder")? {
        Some(f) => Some(crate::mcp::links_subfolder(f, &links_folder(&root))?),
        None => None,
    };
    let result = links::clip(
        &root,
        app_data,
        ClipRequest {
            url,
            html,
            title: title.map(str::to_string),
            tags,
            folder,
            ..ClipRequest::default()
        },
    )
    .map_err(|e| e.to_string())?;
    let path = result
        .path
        .strip_prefix(&root)
        .map_err(|_| "the note is outside the vault".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(json!({"ok": true, "path": path, "created": result.created, "vault": vault.name}))
}

/// The answer to one message (the bytes of a frame).
pub fn handle(body: &[u8], vaults: &[KnownVault], app_data: &Path) -> Value {
    let msg: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return failure(format!("not JSON: {e}")),
    };
    match msg.get("type").and_then(Value::as_str) {
        Some("clip") => clip(&msg, vaults, app_data).unwrap_or_else(failure),
        Some("vaults") => vaults_answer(vaults),
        Some(other) => failure(format!("unknown message type \"{other}\"")),
        None => failure("`type` is missing"),
    }
}

/// Answers the frames of `input` on `out` until the browser closes the port. A frame over the
/// limit or cut off is answered once and ends the conversation.
pub fn serve(
    input: &mut dyn Read,
    out: &mut dyn Write,
    vaults: &[KnownVault],
    app_data: &Path,
) -> io::Result<()> {
    loop {
        match read_frame(input) {
            Ok(Some(body)) => write_frame(out, &handle(&body, vaults, app_data))?,
            Ok(None) => return Ok(()),
            Err(FrameError::TooLarge(n)) => {
                return write_frame(
                    out,
                    &failure(format!(
                        "message of {n} bytes is over the limit of {MAX_MESSAGE_BYTES}"
                    )),
                )
            }
            Err(FrameError::Truncated) => {
                return write_frame(out, &failure("the message was cut off"))
            }
            Err(FrameError::Io(e)) => return Err(e),
        }
    }
}

/// `nixe native-host`: the process the browser starts. Extra arguments (the origin, Firefox
/// adds the manifest path) are ignored.
pub fn run(app_data: &Path) -> Result<(), CliError> {
    let vaults = known_vaults(app_data);
    serve(
        &mut io::stdin().lock(),
        &mut io::stdout().lock(),
        &vaults,
        app_data,
    )
    .map_err(|e| CliError::Failed(e.to_string()))
}

// ---- Host manifests -------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    MacOs,
    Windows,
}

impl Os {
    pub const CURRENT: Os = if cfg!(target_os = "macos") {
        Os::MacOs
    } else if cfg!(windows) {
        Os::Windows
    } else {
        Os::Linux
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Browser {
    Chrome,
    Edge,
    Brave,
    Firefox,
}

impl Browser {
    pub const ALL: [Browser; 4] = [
        Browser::Chrome,
        Browser::Edge,
        Browser::Brave,
        Browser::Firefox,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Browser::Chrome => "Chrome",
            Browser::Edge => "Edge",
            Browser::Brave => "Brave",
            Browser::Firefox => "Firefox",
        }
    }

    pub fn is_firefox(self) -> bool {
        self == Browser::Firefox
    }
}

/// The manifest text for `browser`; `host` is the executable the browser starts.
pub fn manifest(browser: Browser, host: &Path) -> Value {
    let mut m = json!({
        "name": HOST_NAME,
        "description": DESCRIPTION,
        "path": crate::path_to_string(host),
        "type": "stdio",
    });
    if browser.is_firefox() {
        m["allowed_extensions"] = json!(ALLOWED_FIREFOX_EXTENSIONS);
    } else {
        let origins: Vec<String> = ALLOWED_CHROMIUM_EXTENSIONS
            .iter()
            .map(|id| format!("chrome-extension://{id}/"))
            .collect();
        m["allowed_origins"] = json!(origins);
    }
    m
}

/// Where a browser looks for the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub browser: Browser,
    /// The manifest file. On Windows one file for all browsers (in the data directory) and the
    /// registry key points to it.
    pub file: PathBuf,
    /// Directory that exists when the browser is installed (Linux and macOS); the host is not
    /// registered for a browser that is not there.
    pub profile_dir: Option<PathBuf>,
    /// Windows: the registry key below `HKEY_CURRENT_USER`.
    pub registry_key: Option<String>,
}

pub fn targets(os: Os, home: &Path, data: &Path) -> Vec<Target> {
    Browser::ALL
        .iter()
        .map(|&browser| match os {
            Os::Windows => {
                let vendor = match browser {
                    Browser::Chrome => "Google\\Chrome",
                    Browser::Edge => "Microsoft\\Edge",
                    Browser::Brave => "BraveSoftware\\Brave-Browser",
                    Browser::Firefox => "Mozilla",
                };
                let file = if browser.is_firefox() {
                    "native-host-firefox.json"
                } else {
                    "native-host-chromium.json"
                };
                Target {
                    browser,
                    file: data.join(file),
                    profile_dir: None,
                    registry_key: Some(format!(
                        "Software\\{vendor}\\NativeMessagingHosts\\{HOST_NAME}"
                    )),
                }
            }
            Os::Linux | Os::MacOs => {
                let (profile, hosts) = match (os, browser) {
                    (Os::MacOs, Browser::Chrome) => (
                        "Library/Application Support/Google/Chrome",
                        "NativeMessagingHosts",
                    ),
                    (Os::MacOs, Browser::Edge) => (
                        "Library/Application Support/Microsoft Edge",
                        "NativeMessagingHosts",
                    ),
                    (Os::MacOs, Browser::Brave) => (
                        "Library/Application Support/BraveSoftware/Brave-Browser",
                        "NativeMessagingHosts",
                    ),
                    (Os::MacOs, Browser::Firefox) => (
                        "Library/Application Support/Mozilla",
                        "NativeMessagingHosts",
                    ),
                    (_, Browser::Chrome) => (".config/google-chrome", "NativeMessagingHosts"),
                    (_, Browser::Edge) => (".config/microsoft-edge", "NativeMessagingHosts"),
                    (_, Browser::Brave) => (
                        ".config/BraveSoftware/Brave-Browser",
                        "NativeMessagingHosts",
                    ),
                    (_, Browser::Firefox) => (".mozilla", "native-messaging-hosts"),
                };
                let profile = home.join(profile);
                Target {
                    browser,
                    file: profile.join(hosts).join(format!("{HOST_NAME}.json")),
                    profile_dir: Some(profile),
                    registry_key: None,
                }
            }
        })
        .collect()
}

/// The script the manifests point to: a manifest `path` cannot carry arguments.
pub fn launcher(os: Os, data: &Path) -> PathBuf {
    data.join(match os {
        Os::Windows => "nixe-native-host.cmd",
        _ => "nixe-native-host",
    })
}

pub fn launcher_script(os: Os, exe: &Path) -> String {
    match os {
        Os::Windows => format!(
            "@echo off\r\n\"{}\" native-host %*\r\n",
            exe.to_string_lossy()
        ),
        _ => format!(
            "#!/bin/sh\nexec '{}' native-host \"$@\"\n",
            exe.to_string_lossy().replace('\'', "'\\''")
        ),
    }
}

/// The `reg` arguments that point the browser to the manifest file.
pub fn registry_args(key: &str, file: &Path) -> Vec<String> {
    vec![
        "add".into(),
        format!("HKCU\\{key}"),
        "/ve".into(),
        "/t".into(),
        "REG_SZ".into(),
        "/d".into(),
        file.to_string_lossy().into_owned(),
        "/f".into(),
    ]
}

fn write_file(path: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::read_to_string(path).is_ok_and(|old| old == text) {
        return Ok(());
    }
    std::fs::write(path, text)
}

/// Writes the launcher and the manifests for the browsers that are installed, and returns their
/// labels. Safe to repeat: the files are rewritten with the same content.
/// `register` runs for each registry key (Windows); tests pass a recorder.
pub fn install_with(
    os: Os,
    exe: &Path,
    home: &Path,
    data: &Path,
    register: &mut dyn FnMut(&str, &Path) -> io::Result<()>,
) -> io::Result<Vec<&'static str>> {
    let host = launcher(os, data);
    write_file(&host, &launcher_script(os, exe))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&host, std::fs::Permissions::from_mode(0o755))?;
    }
    let mut done = Vec::new();
    for t in targets(os, home, data) {
        if t.profile_dir.as_ref().is_some_and(|d| !d.is_dir()) {
            continue;
        }
        let text =
            serde_json::to_string_pretty(&manifest(t.browser, &host)).map_err(io::Error::other)?;
        write_file(&t.file, &text)?;
        if let Some(key) = &t.registry_key {
            register(key, &t.file)?;
        }
        done.push(t.browser.label());
    }
    Ok(done)
}

/// [`install_with`] for this machine.
pub fn install(app_data: &Path) -> Result<Vec<&'static str>, String> {
    let exe = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|e| e.to_string())?;
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or("cannot locate the home directory")?;
    let browsers = install_with(Os::CURRENT, &exe, &home, app_data, &mut |key, file| {
        let status = std::process::Command::new("reg")
            .args(registry_args(key, file))
            .output()?;
        if status.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(
                String::from_utf8_lossy(&status.stderr).trim().to_string(),
            ))
        }
    })
    .map_err(|e| e.to_string())?;
    if browsers.is_empty() {
        Err("No supported browser found (Chrome, Edge, Brave or Firefox).".into())
    } else {
        Ok(browsers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-nh-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn frame(value: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        write_frame(&mut out, value).unwrap();
        out
    }

    /// Hands out at most `step` bytes per read.
    struct Trickle<'a>(&'a [u8], usize);
    impl Read for Trickle<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.1.min(buf.len()).min(self.0.len());
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            Ok(n)
        }
    }

    fn answers(bytes: &[u8]) -> Vec<Value> {
        let mut input = bytes;
        let mut out = Vec::new();
        while let Some(body) = read_frame(&mut input).unwrap() {
            out.push(serde_json::from_slice(&body).unwrap());
        }
        out
    }

    #[test]
    fn frame_has_a_native_length_prefix() {
        let bytes = frame(&json!({"a": 1}));
        assert_eq!(&bytes[..4], &7u32.to_ne_bytes());
        assert_eq!(&bytes[4..], br#"{"a":1}"#);
    }

    #[test]
    fn reads_a_frame_from_split_reads() {
        let bytes = frame(&json!({"type": "vaults"}));
        let body = read_frame(&mut Trickle(&bytes, 1)).unwrap().unwrap();
        assert_eq!(body, br#"{"type":"vaults"}"#);
        let two = [bytes.clone(), bytes].concat();
        let mut input = Trickle(&two, 3);
        assert!(read_frame(&mut input).unwrap().is_some());
        assert!(read_frame(&mut input).unwrap().is_some());
        assert!(read_frame(&mut input).unwrap().is_none());
    }

    #[test]
    fn a_cut_off_frame_is_an_error() {
        let mut bytes = frame(&json!({"type": "vaults"}));
        bytes.truncate(bytes.len() - 2);
        assert!(matches!(
            read_frame(&mut bytes.as_slice()),
            Err(FrameError::Truncated)
        ));
        assert!(matches!(
            read_frame(&mut [1u8, 0].as_slice()),
            Err(FrameError::Truncated)
        ));
    }

    #[test]
    fn a_message_over_the_limit_is_refused_without_reading_it() {
        let len = (MAX_MESSAGE_BYTES as u32 + 1).to_ne_bytes();
        assert!(matches!(
            read_frame(&mut len.as_slice()),
            Err(FrameError::TooLarge(n)) if n == MAX_MESSAGE_BYTES + 1
        ));
        let mut out = Vec::new();
        serve(&mut len.as_slice(), &mut out, &[], Path::new("")).unwrap();
        let a = answers(&out);
        assert_eq!(a[0]["ok"], false);
        assert!(a[0]["error"].as_str().unwrap().contains("limit"));
        // A message at the limit is read.
        let mut at = (MAX_MESSAGE_BYTES as u32).to_ne_bytes().to_vec();
        at.extend(vec![b' '; MAX_MESSAGE_BYTES]);
        assert_eq!(
            read_frame(&mut at.as_slice()).unwrap().unwrap().len(),
            MAX_MESSAGE_BYTES
        );
    }

    #[test]
    fn unknown_and_malformed_messages_answer_an_error() {
        let none: &[KnownVault] = &[];
        let d = Path::new("");
        let r = handle(br#"{"type":"explode"}"#, none, d);
        assert_eq!(r["ok"], false);
        assert!(r["error"].as_str().unwrap().contains("explode"));
        assert_eq!(handle(b"{}", none, d)["ok"], false);
        assert_eq!(handle(b"nope", none, d)["ok"], false);
        assert_eq!(handle(br#"{"type":"clip"}"#, none, d)["ok"], false);
    }

    fn vault_with_links(name: &str) -> (PathBuf, KnownVault) {
        let root = temp_dir(name);
        fs::create_dir_all(root.join("Links/Reading")).unwrap();
        fs::create_dir_all(root.join("Links/.archive")).unwrap();
        let vault = KnownVault {
            name: "main".into(),
            path: root.clone(),
        };
        (root, vault)
    }

    #[test]
    fn vaults_lists_the_links_folder_and_its_sub_folders() {
        let (_, vault) = vault_with_links("vaults");
        let r = handle(br#"{"type":"vaults"}"#, &[vault], Path::new(""));
        assert_eq!(r["ok"], true);
        assert_eq!(r["vaults"][0]["name"], "main");
        assert_eq!(r["vaults"][0]["folder"], "Links");
        assert_eq!(r["vaults"][0]["folders"], json!(["Links/Reading"]));
    }

    #[test]
    fn clip_saves_the_note_and_repeats_safely() {
        let (root, vault) = vault_with_links("clip");
        let data = temp_dir("clip-data");
        let msg = json!({
            "type": "clip",
            "url": "https://example.com/a",
            "title": "Example",
            "html": "<html><head><title>T</title></head><body><p>Hello world</p></body></html>",
            "tags": ["reading"],
            "folder": "Links/Reading",
        });
        let body = serde_json::to_vec(&msg).unwrap();
        let first = handle(&body, std::slice::from_ref(&vault), &data);
        assert_eq!(first["ok"], true, "{first}");
        assert_eq!(first["created"], true);
        let path = first["path"].as_str().unwrap();
        assert!(path.starts_with("Links/Reading/"), "{path}");
        let note = fs::read_to_string(root.join(path)).unwrap();
        assert!(note.contains("type: link") && note.contains("title: Example"));
        let again = handle(&body, &[vault], &data);
        assert_eq!(again["created"], false);
        assert_eq!(again["path"], first["path"]);
    }

    #[test]
    fn clip_refuses_a_folder_outside_the_links_folder_and_unknown_vaults() {
        let (_, vault) = vault_with_links("refuse");
        let data = temp_dir("refuse-data");
        let clip = |extra: Value| {
            let mut m = json!({"type": "clip", "url": "https://example.com/b", "html": "<p>x</p>"});
            m.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            handle(
                &serde_json::to_vec(&m).unwrap(),
                std::slice::from_ref(&vault),
                &data,
            )
        };
        for folder in ["../x", "/etc", "Notes", "Links/../Notes"] {
            assert_eq!(clip(json!({"folder": folder}))["ok"], false, "{folder}");
        }
        assert_eq!(clip(json!({"vault": "/tmp"}))["ok"], false);
        assert_eq!(clip(json!({"tags": "a"}))["ok"], false);
        assert_eq!(clip(json!({"url": "file:///etc/passwd"}))["ok"], false);
        assert_eq!(clip(json!({"vault": "main"}))["ok"], true);
    }

    #[test]
    fn serve_answers_each_frame_until_the_port_closes() {
        let (_, vault) = vault_with_links("serve");
        let input = [
            frame(&json!({"type": "vaults"})),
            frame(&json!({"type": "nope"})),
        ]
        .concat();
        let mut out = Vec::new();
        serve(&mut Trickle(&input, 5), &mut out, &[vault], Path::new("")).unwrap();
        let a = answers(&out);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0]["ok"], true);
        assert_eq!(a[1]["ok"], false);
    }

    #[test]
    fn known_vaults_come_from_the_saved_workspaces() {
        let data = temp_dir("known");
        assert!(known_vaults(&data).is_empty());
        let vault = temp_dir("known-vault");
        let dir = data.join(workspace::DIR);
        fs::create_dir_all(&dir).unwrap();
        let ws = json!({"name": "one", "roots": [
            {"path": crate::path_to_string(&vault), "name": "v", "kind": "folder"},
            {"path": "/does/not/exist", "name": "gone", "kind": "folder"},
        ]});
        fs::write(dir.join("one.json"), ws.to_string()).unwrap();
        fs::write(dir.join("two.json"), ws.to_string()).unwrap();
        let known = known_vaults(&data);
        assert_eq!(known.len(), 1);
        assert_eq!(known[0].name, "v");
    }

    #[test]
    fn manifest_content_per_browser() {
        let host = Path::new("/data/nixe-native-host");
        for b in [Browser::Chrome, Browser::Edge, Browser::Brave] {
            let m = manifest(b, host);
            assert_eq!(m["name"], "app.gravionlabs.nixe");
            assert_eq!(m["type"], "stdio");
            assert_eq!(m["path"], "/data/nixe-native-host");
            assert_eq!(
                m["allowed_origins"][0],
                format!("chrome-extension://{}/", ALLOWED_CHROMIUM_EXTENSIONS[0])
            );
            assert!(m.get("allowed_extensions").is_none());
        }
        let f = manifest(Browser::Firefox, host);
        assert_eq!(f["allowed_extensions"][0], ALLOWED_FIREFOX_EXTENSIONS[0]);
        assert!(f.get("allowed_origins").is_none());
    }

    #[test]
    fn manifest_locations_per_os() {
        let home = Path::new("/home/u");
        let data = Path::new("/data");
        let file = |os, b| {
            targets(os, home, data)
                .into_iter()
                .find(|t| t.browser == b)
                .unwrap()
        };
        assert_eq!(
            file(Os::Linux, Browser::Chrome).file,
            Path::new(
                "/home/u/.config/google-chrome/NativeMessagingHosts/app.gravionlabs.nixe.json"
            )
        );
        assert_eq!(
            file(Os::Linux, Browser::Firefox).file,
            Path::new("/home/u/.mozilla/native-messaging-hosts/app.gravionlabs.nixe.json")
        );
        assert_eq!(
            file(Os::MacOs, Browser::Edge).file,
            Path::new("/home/u/Library/Application Support/Microsoft Edge/NativeMessagingHosts/app.gravionlabs.nixe.json")
        );
        assert_eq!(
            file(Os::MacOs, Browser::Brave).file,
            Path::new("/home/u/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/app.gravionlabs.nixe.json")
        );
        let w = file(Os::Windows, Browser::Brave);
        assert_eq!(
            w.registry_key.as_deref(),
            Some("Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\app.gravionlabs.nixe")
        );
        assert_eq!(w.file, Path::new("/data/native-host-chromium.json"));
        assert_eq!(
            file(Os::Windows, Browser::Firefox).registry_key.as_deref(),
            Some("Software\\Mozilla\\NativeMessagingHosts\\app.gravionlabs.nixe")
        );
        assert_eq!(
            registry_args("Software\\X", Path::new("C:\\m.json")),
            [
                "add",
                "HKCU\\Software\\X",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                "C:\\m.json",
                "/f"
            ]
        );
    }

    #[test]
    fn launcher_passes_the_subcommand() {
        assert_eq!(
            launcher_script(Os::Linux, Path::new("/o/it's/nixe")),
            "#!/bin/sh\nexec '/o/it'\\''s/nixe' native-host \"$@\"\n"
        );
        assert_eq!(
            launcher_script(Os::Windows, Path::new("C:\\Nixe\\nixe.exe")),
            "@echo off\r\n\"C:\\Nixe\\nixe.exe\" native-host %*\r\n"
        );
    }

    #[test]
    fn install_writes_for_installed_browsers_only_and_is_repeat_safe() {
        let home = temp_dir("inst-home");
        let data = temp_dir("inst-data");
        fs::create_dir_all(home.join(".config/google-chrome")).unwrap();
        fs::create_dir_all(home.join(".mozilla")).unwrap();
        let exe = Path::new("/opt/nixe/nixe");
        let run = || install_with(Os::Linux, exe, &home, &data, &mut |_, _| Ok(())).unwrap();
        assert_eq!(run(), ["Chrome", "Firefox"]);
        assert_eq!(run(), ["Chrome", "Firefox"]);
        assert!(!home.join(".config/microsoft-edge").exists());
        let m: Value = serde_json::from_str(
            &fs::read_to_string(
                home.join(".config/google-chrome/NativeMessagingHosts/app.gravionlabs.nixe.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            m["path"],
            crate::path_to_string(&data.join("nixe-native-host"))
        );
        assert!(fs::read_to_string(data.join("nixe-native-host"))
            .unwrap()
            .contains("native-host"));
    }

    #[test]
    fn install_registers_every_browser_on_windows() {
        let data = temp_dir("inst-win");
        let mut keys = Vec::new();
        let done = install_with(
            Os::Windows,
            Path::new("C:\\nixe.exe"),
            Path::new("C:\\u"),
            &data,
            &mut |k, f| {
                keys.push((k.to_string(), f.to_path_buf()));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(done.len(), 4);
        assert_eq!(keys.len(), 4);
        assert!(data.join("native-host-firefox.json").is_file());
        assert!(data.join("nixe-native-host.cmd").is_file());
    }
}
