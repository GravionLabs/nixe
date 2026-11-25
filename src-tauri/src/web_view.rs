//! Spike (#567): a web page in a child webview over the tab area of the `main` window. The result
//! decides ADR 0010; the web tab kind itself follows later.
//!
//! The page is remote content. It gets no IPC (Tauri rejects commands of a remote origin because no
//! capability names `remote` URLs), its own data store, no new windows and no downloads, and it may
//! only visit `http`/`https` URLs outside `localhost`: Tauri treats `localhost` and `*.localhost`
//! addresses (dev server, custom protocols on Windows) as the app itself, which may call commands.

use serde::Deserialize;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

/// Place of a web view in the `main` window, in logical (CSS) pixels.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The URL when a web view may show it: `http` or `https` and not an address of the app.
fn parse_web_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|e| format!("invalid URL {url}: {e}"))?;
    if !is_web_url(&parsed) {
        return Err(format!("not a web address: {url}"));
    }
    Ok(parsed)
}

fn is_web_url(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    url.host_str().is_some_and(|host| {
        let host = host.trim_end_matches('.');
        host != "localhost" && !host.ends_with(".localhost")
    })
}

/// What the page may navigate to, frames included: web addresses and the empty documents of frames.
fn may_navigate(url: &Url) -> bool {
    matches!(url.as_str(), "about:blank" | "about:srcdoc") || is_web_url(url)
}

/// Position and size of the bounds: a negative position becomes 0, the size is at least 1×1.
fn to_rect(bounds: Bounds) -> Result<(LogicalPosition<f64>, LogicalSize<f64>), String> {
    let Bounds {
        x,
        y,
        width,
        height,
    } = bounds;
    if ![x, y, width, height].iter().all(|v| v.is_finite()) {
        return Err("bounds must be finite numbers".into());
    }
    Ok((
        LogicalPosition::new(x.max(0.0), y.max(0.0)),
        LogicalSize::new(width.max(1.0), height.max(1.0)),
    ))
}

/// The webview label of a web view id. The prefix keeps it apart from `main` and `capture`.
fn label(id: &str) -> Result<String, String> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(format!("invalid web view id: {id}"));
    }
    Ok(format!("web-{id}"))
}

fn find(app: &AppHandle, id: &str) -> Result<Webview, String> {
    app.get_webview(&label(id)?)
        .ok_or_else(|| format!("no web view {id}"))
}

// The commands are async: creating a webview in a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn web_view_open(
    app: AppHandle,
    id: String,
    url: String,
    bounds: Bounds,
) -> Result<(), String> {
    let label = label(&id)?;
    let url = parse_web_url(&url)?;
    let (position, size) = to_rect(bounds)?;
    if app.get_webview(&label).is_some() {
        return Err(format!("web view {id} is already open"));
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .on_navigation(may_navigate)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false);
    // WKWebView ignores a data directory: a non persistent store keeps the page apart there.
    #[cfg(target_os = "macos")]
    let builder = builder.incognito(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.data_directory(
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("web-view"),
    );
    let webview = window
        .add_child(builder, position, size)
        .map_err(|e| e.to_string())?;
    place(&webview, position, size)
}

#[tauri::command]
pub async fn web_view_set_bounds(app: AppHandle, id: String, bounds: Bounds) -> Result<(), String> {
    let (position, size) = to_rect(bounds)?;
    place(&find(&app, &id)?, position, size)
}

#[tauri::command]
pub async fn web_view_set_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    let webview = find(&app, &id)?;
    let result = if visible {
        webview.show()
    } else {
        webview.hide()
    };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn web_view_close(app: AppHandle, id: String) -> Result<(), String> {
    find(&app, &id)?.close().map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn place(
    webview: &Webview,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<(), String> {
    webview
        .set_bounds(tauri::Rect {
            position: position.into(),
            size: size.into(),
        })
        .map_err(|e| e.to_string())
}

/// GTK: Tauri packs a child webview into the vertical box of the window, below the app, and ignores
/// its bounds. The main webview is therefore wrapped in a `gtk::Overlay` once, and the child becomes
/// an overlay of it, placed by its margins and size request.
#[cfg(target_os = "linux")]
fn place(
    webview: &Webview,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<(), String> {
    webview
        .with_webview(move |platform| {
            use gtk::prelude::*;

            let child = platform.inner();
            let Some(parent) = child.parent() else {
                return log::error!("web view without a parent widget");
            };
            if let Some(vbox) = parent.downcast_ref::<gtk::Box>() {
                let existing = vbox
                    .children()
                    .into_iter()
                    .find_map(|c| c.downcast::<gtk::Overlay>().ok());
                let overlay = match existing {
                    Some(overlay) => overlay,
                    None => {
                        // The first webview of the box is the one of the app.
                        let Some(main) = vbox.children().into_iter().find(|c| {
                            c.is::<webkit2gtk::WebView>() && c != child.upcast_ref::<gtk::Widget>()
                        }) else {
                            return log::error!("no webview of the app in the window");
                        };
                        let overlay = gtk::Overlay::new();
                        vbox.remove(&main);
                        overlay.add(&main);
                        vbox.pack_start(&overlay, true, true, 0);
                        overlay.show();
                        main.grab_focus();
                        overlay
                    }
                };
                vbox.remove(&child);
                overlay.add_overlay(&child);
                child.set_halign(gtk::Align::Start);
                child.set_valign(gtk::Align::Start);
            }
            child.set_margin_start(position.x.round() as i32);
            child.set_margin_top(position.y.round() as i32);
            child.set_size_request(size.width.round() as i32, size.height.round() as i32);
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_urls() {
        for url in [
            "http://example.com",
            "https://example.com/a?b=1#c",
            "https://93.184.216.34:8443/",
        ] {
            assert!(parse_web_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn refuses_other_schemes() {
        for url in [
            "file:///etc/passwd",
            "tauri://localhost/index.html",
            "javascript:alert(1)",
            "asset://localhost/etc/passwd",
            "data:text/html,x",
            "about:blank",
            "ipc://localhost/read_text_file",
            "example.com",
            "",
        ] {
            assert!(parse_web_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn refuses_the_addresses_of_the_app() {
        for url in [
            "http://localhost:1420/",
            "http://LOCALHOST./",
            "http://tauri.localhost/",
            "https://tauri.localhost./index.html",
            "http://asset.localhost/x",
            "http://ipc.localhost/read_text_file",
        ] {
            assert!(parse_web_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn navigation_allows_web_pages_and_empty_frames_only() {
        let allowed = |url: &str| may_navigate(&Url::parse(url).unwrap());
        assert!(allowed("https://example.com/next"));
        assert!(allowed("about:blank"));
        assert!(allowed("about:srcdoc"));
        assert!(!allowed("tauri://localhost/"));
        assert!(!allowed("http://tauri.localhost/"));
        assert!(!allowed("file:///etc/passwd"));
    }

    #[test]
    fn bounds_become_a_visible_rectangle() {
        let rect = |x, y, width, height| {
            to_rect(Bounds {
                x,
                y,
                width,
                height,
            })
        };
        assert_eq!(
            rect(10.5, 20.0, 300.0, 200.0).unwrap(),
            (
                LogicalPosition::new(10.5, 20.0),
                LogicalSize::new(300.0, 200.0)
            )
        );
        assert_eq!(
            rect(-5.0, -1.0, 0.0, -3.0).unwrap(),
            (LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        );
        assert!(rect(f64::NAN, 0.0, 1.0, 1.0).is_err());
        assert!(rect(0.0, 0.0, f64::INFINITY, 1.0).is_err());
    }

    #[test]
    fn labels_are_prefixed_and_checked() {
        assert_eq!(label("spike-1").unwrap(), "web-spike-1");
        assert!(label("").is_err());
        assert!(label("a b").is_err());
        assert!(label(&"x".repeat(65)).is_err());
    }
}
