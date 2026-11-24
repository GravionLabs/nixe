//! The optional screenshot and PDF of a link note (#506): with `screenshot` or `pdf` in
//! `links.archive` the desktop app loads the page in a hidden webview and stores a PNG and/or a
//! PDF next to the HTML archive. The CLI has no webview and skips both (see `clip_rendered`).
//!
//! The webview follows the security rule of the web tab (#461): its label matches no capability
//! file, so the page has no IPC, and it has its own data store (a private session), so it shares
//! no cookies or storage with the app. Platforms: WebKitGTK (Linux) renders both; WKWebView and
//! WebView2 are not wired yet, a format that a platform cannot render is logged and skipped.

use std::fmt;
use std::sync::mpsc;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// The setting values of `links.archive` that ask for a render.
pub const SCREENSHOT: &str = "screenshot";
pub const PDF: &str = "pdf";
/// The viewport width of the screenshot and the page layout of the PDF.
pub const VIEWPORT_WIDTH: f64 = 1280.0;
const VIEWPORT_HEIGHT: f64 = 800.0;
/// Time after the load event for scripts, fonts and lazy images.
const SETTLE: Duration = Duration::from_millis(1500);
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(60);
/// The label prefix of the render windows; no capability file names it.
pub const WINDOW_PREFIX: &str = "link-render";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Screenshot,
    Pdf,
}

impl Format {
    /// The format a `links.archive` entry asks for; `html` and unknown values are none.
    pub fn from_setting(value: &str) -> Option<Format> {
        match value {
            SCREENSHOT => Some(Format::Screenshot),
            PDF => Some(Format::Pdf),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Format::Screenshot => SCREENSHOT,
            Format::Pdf => PDF,
        }
    }

    /// The file extension of the archive file.
    pub fn extension(self) -> &'static str {
        match self {
            Format::Screenshot => "png",
            Format::Pdf => "pdf",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    /// The platform has no way to make this format (yet).
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    Unsupported(String),
    Failed(String),
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RenderError::Unsupported(m) | RenderError::Failed(m) => f.write_str(m),
        }
    }
}

/// Renders a page into files. One call serves all formats, so the page loads once.
pub trait Renderer {
    fn render(&self, url: &str, formats: &[Format]) -> Vec<(Format, Result<Vec<u8>, RenderError>)>;
}

/// The renderer of the app: a hidden webview window.
pub struct AppRenderer {
    app: AppHandle,
}

impl AppRenderer {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn load(&self, url: &str) -> Result<tauri::WebviewWindow, RenderError> {
        use std::sync::atomic::{AtomicU32, Ordering};
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let parsed: tauri::Url = url
            .parse()
            .map_err(|e| RenderError::Failed(format!("{url}: {e}")))?;
        let label = format!("{WINDOW_PREFIX}-{}", NEXT.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel();
        let window = WebviewWindowBuilder::new(&self.app, label, WebviewUrl::External(parsed))
            .title("Nixe link render")
            // A private session: no cookies or storage shared with the app or earlier renders.
            .incognito(true)
            .inner_size(VIEWPORT_WIDTH, VIEWPORT_HEIGHT)
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .on_navigation(|u| matches!(u.scheme(), "http" | "https"))
            .on_page_load(move |_, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = tx.send(());
                }
            })
            .build()
            .map_err(|e| RenderError::Failed(e.to_string()))?;
        match rx.recv_timeout(LOAD_TIMEOUT) {
            Ok(()) => {
                std::thread::sleep(SETTLE);
                Ok(window)
            }
            Err(_) => {
                let _ = window.destroy();
                Err(RenderError::Failed(format!(
                    "{url}: not loaded within {} s",
                    LOAD_TIMEOUT.as_secs()
                )))
            }
        }
    }
}

impl Renderer for AppRenderer {
    fn render(&self, url: &str, formats: &[Format]) -> Vec<(Format, Result<Vec<u8>, RenderError>)> {
        let window = match self.load(url) {
            Ok(w) => w,
            Err(e) => return formats.iter().map(|f| (*f, Err(e.clone()))).collect(),
        };
        let out = formats
            .iter()
            .map(|format| {
                let (tx, rx) = mpsc::channel();
                let format = *format;
                let queued =
                    window.with_webview(move |webview| platform::capture(webview, format, tx));
                let result = match queued {
                    Err(e) => Err(RenderError::Failed(e.to_string())),
                    Ok(()) => rx
                        .recv_timeout(CAPTURE_TIMEOUT)
                        .unwrap_or_else(|_| Err(RenderError::Failed("timed out".into()))),
                };
                (format, result)
            })
            .collect();
        let _ = window.destroy();
        out
    }
}

/// Saves the page of `url` as a link note with the screenshot and the PDF that `links.archive`
/// asks for (the desktop app only; `nixe clip` skips them).
#[tauri::command]
pub async fn clip_link(
    app: AppHandle,
    root: String,
    url: String,
    title: Option<String>,
    tags: Vec<String>,
    folder: Option<String>,
) -> Result<super::ClipResult, String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let renderer = AppRenderer::new(app);
        super::clip_rendered(
            std::path::Path::new(&root),
            &data_dir,
            super::ClipRequest {
                url,
                html: None,
                title,
                tags,
                folder,
            },
            &chrono::Local::now().fixed_offset(),
            &super::fetch::fetch,
            Some(&renderer),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

type Reply = mpsc::Sender<Result<Vec<u8>, RenderError>>;

#[cfg(target_os = "linux")]
mod platform {
    use super::{Format, RenderError, Reply};
    use webkit2gtk::{
        PrintOperation, PrintOperationExt, SnapshotOptions, SnapshotRegion, WebViewExt,
    };

    /// Runs on the main thread; the answer comes through `reply` when WebKit is done.
    pub fn capture(webview: tauri::webview::PlatformWebview, format: Format, reply: Reply) {
        let view = webview.inner();
        match format {
            Format::Screenshot => view.snapshot(
                SnapshotRegion::FullDocument,
                SnapshotOptions::NONE,
                gtk::gio::Cancellable::NONE,
                move |result| {
                    let _ = reply.send(
                        result
                            .map_err(|e| RenderError::Failed(e.to_string()))
                            .and_then(png),
                    );
                },
            ),
            Format::Pdf => pdf(&view, reply),
        }
    }

    fn png(surface: gtk::cairo::Surface) -> Result<Vec<u8>, RenderError> {
        let failed = |e: String| RenderError::Failed(e);
        let image = gtk::cairo::ImageSurface::try_from(surface)
            .map_err(|_| failed("the snapshot is not an image".into()))?;
        let mut bytes = Vec::new();
        image
            .write_to_png(&mut bytes)
            .map_err(|e| failed(e.to_string()))?;
        Ok(bytes)
    }

    /// WebKitGTK prints through GTK; the print settings name a file, no dialog opens.
    fn pdf(view: &webkit2gtk::WebView, reply: Reply) {
        let path = std::env::temp_dir().join(format!(
            "nixe-render-{}-{:?}.pdf",
            std::process::id(),
            std::time::Instant::now()
        ));
        let path = path.to_string_lossy().replace(' ', "_");
        let settings = gtk::PrintSettings::new();
        settings.set("output-uri", Some(&format!("file://{path}")));
        settings.set("output-file-format", Some("pdf"));
        settings.set_paper_size(&gtk::PaperSize::new(Some("iso_a4")));
        let operation = PrintOperation::new(view);
        operation.set_print_settings(&settings);
        let (done, failed) = (reply.clone(), reply);
        let file = path.clone();
        operation.connect_finished(move |_| {
            let bytes = std::fs::read(&file).map_err(|e| RenderError::Failed(e.to_string()));
            let _ = std::fs::remove_file(&file);
            let _ = done.send(bytes);
        });
        operation.connect_failed(move |_, e| {
            let _ = failed.send(Err(RenderError::Failed(e.to_string())));
        });
        operation.print();
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use super::{Format, RenderError, Reply};

    /// WKWebView (`takeSnapshot`, `createPDF`) and WebView2 (`CapturePreview`, `PrintToPdf`) are
    /// not wired yet: the format is skipped with a log line and the clip succeeds.
    pub fn capture(_: tauri::webview::PlatformWebview, format: Format, reply: Reply) {
        let _ = reply.send(Err(RenderError::Unsupported(format!(
            "{} is not available on this platform yet",
            format.name()
        ))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_settings_name_their_formats() {
        assert_eq!(Format::from_setting("screenshot"), Some(Format::Screenshot));
        assert_eq!(Format::from_setting("pdf"), Some(Format::Pdf));
        assert_eq!(Format::from_setting("html"), None);
        assert_eq!(Format::Screenshot.extension(), "png");
        assert_eq!(Format::Pdf.extension(), "pdf");
    }

    /// The render window has no IPC: no capability file may name its label (#461).
    #[test]
    fn no_capability_reaches_the_render_windows() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut seen = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            let json: serde_json::Value = serde_json::from_str(&text).unwrap();
            seen += 1;
            assert!(json.get("webviews").is_none(), "{text}");
            for window in json["windows"].as_array().into_iter().flatten() {
                let pattern = window.as_str().unwrap();
                let label = format!("{WINDOW_PREFIX}-0");
                let hit = match pattern.strip_suffix('*') {
                    Some(prefix) => label.starts_with(prefix),
                    None => pattern == label,
                };
                assert!(!hit, "{pattern} reaches the render window");
            }
        }
        assert!(seen > 0);
    }
}
