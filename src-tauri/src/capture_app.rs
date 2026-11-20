//! The Tauri side of the capture window (#118): the global shortcut, the hidden always-on-top
//! window, a tray icon that keeps the app reachable without a main window, and the commands the
//! window calls.

use std::path::Path;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::{capture, path_to_string, settings};

/// Label of the capture window.
pub const WINDOW: &str = "capture";
const TRAY: &str = "capture-tray";
/// Event to the capture window: it was shown and starts empty.
const SHOWN_EVENT: &str = "capture-shown";

/// The shortcut plugin, with the handler that shows the window.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                show(app);
            }
        })
        .build()
}

fn config(app: &AppHandle) -> Result<capture::Config, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(capture::parse_config(
        settings::read_settings(&dir)?.as_deref(),
    ))
}

/// Shows the capture window (created when missing) and tells it to start empty.
pub fn show(app: &AppHandle) {
    let Some(window) = app
        .get_webview_window(WINDOW)
        .or_else(|| build_window(app).ok())
    else {
        return;
    };
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to(WINDOW, SHOWN_EVENT, ());
}

/// The window starts hidden, so the shortcut only has to show it (well below 150 ms).
fn build_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let window =
        WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html#capture".into()))
            .title("Nixe capture")
            .inner_size(560.0, 220.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
    // Closing only hides it, so the next shortcut press is instant.
    let hidden = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hidden.hide();
        }
    });
    Ok(window)
}

/// Brings the main window back, creating it again when it was closed.
fn open_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    if let Some(cfg) = app.config().app.windows.first() {
        let _ = WebviewWindowBuilder::from_config(app, cfg).and_then(|b| b.build());
    }
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    if app.tray_by_id(TRAY).is_some() {
        return Ok(());
    }
    let err = |e: tauri::Error| e.to_string();
    let menu = MenuBuilder::new(app)
        .item(
            &MenuItemBuilder::with_id("capture", "New capture")
                .build(app)
                .map_err(err)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", "Open Nixe")
                .build(app)
                .map_err(err)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("quit", "Quit")
                .build(app)
                .map_err(err)?,
        )
        .build()
        .map_err(err)?;
    let mut tray = TrayIconBuilder::with_id(TRAY)
        .tooltip("Nixe")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "capture" => show(app),
            "open" => open_main(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app).map(|_| ()).map_err(err)
}

/// Makes the registered shortcut, the window and the tray match the settings file. An empty
/// shortcut turns capture off; an invalid one is reported and leaves it off.
pub fn apply(app: &AppHandle) -> Result<(), String> {
    let config = config(app)?;
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    if config.shortcut.is_empty() {
        if let Some(window) = app.get_webview_window(WINDOW) {
            let _ = window.destroy();
        }
        app.remove_tray_by_id(TRAY);
        return Ok(());
    }
    shortcuts
        .register(config.shortcut.as_str())
        .map_err(|e| format!("{}: {e}", config.shortcut))?;
    if app.get_webview_window(WINDOW).is_none() {
        build_window(app)?;
    }
    build_tray(app)
}

/// Writes the captured text to the daily note or the inbox, as the settings say.
#[tauri::command]
pub fn capture_save(app: AppHandle, text: String) -> Result<String, String> {
    let config = config(&app)?;
    let root = config
        .vault
        .clone()
        .ok_or("no vault: open a folder in Nixe first")?;
    let now = chrono::Local::now().fixed_offset();
    capture::save(&root, &config, &text, &now).map(|p| path_to_string(&p))
}

/// Note names of the vault for the `[[` completion; empty without a vault.
#[tauri::command]
pub fn capture_note_names(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(config(&app)?
        .vault
        .as_deref()
        .map(Path::to_path_buf)
        .map(|root| capture::note_names(&root))
        .unwrap_or_default())
}

/// The title of the page at `url`; `None` when it cannot be fetched within two seconds.
#[tauri::command]
pub async fn capture_link_title(url: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || capture::fetch_title(&url, capture::TITLE_TIMEOUT))
        .await
        .ok()
        .flatten()
}

/// Hides the capture window.
#[tauri::command]
pub fn capture_hide(app: AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.hide();
    }
}

/// Re-reads the settings: registers the shortcut, creates or removes the window and the tray.
#[tauri::command]
pub fn capture_apply(app: AppHandle) -> Result<(), String> {
    apply(&app)
}
