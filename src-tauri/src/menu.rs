//! Native application menu. Custom items are forwarded to the frontend as a
//! `menu` event carrying the item id.

use std::collections::HashMap;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, MenuItemKind, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub const MENU_EVENT: &str = "menu";
/// Handled natively (macOS only), never forwarded to the frontend.
pub const INSTALL_CLI_ID: &str = "install-cli";
/// Forwarded to the frontend, which runs the update check and shows the result.
pub const CHECK_UPDATES_ID: &str = "check-updates";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accelerator: Option<&str>| {
        let builder = MenuItemBuilder::with_id(id, label);
        match accelerator {
            Some(acc) => builder.accelerator(acc).build(app),
            None => builder.build(app),
        }
    };

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item("new-note", "New Note", Some("CmdOrCtrl+N"))?)
        .item(&item(
            "quick-switcher",
            "Quick Switcher…",
            Some("CmdOrCtrl+O"),
        )?)
        .item(&item(
            "command-palette",
            "Command Palette…",
            Some("CmdOrCtrl+P"),
        )?)
        .item(&item("open-file", "Open File…", Some("CmdOrCtrl+Shift+P"))?)
        .item(&item(
            "open-folder",
            "Open Folder…",
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .item(&item("open-recent", "Open Recent…", None)?)
        .item(&item("clone-vault", "Clone Vault…", None)?)
        .separator()
        .item(&item("reload", "Reload", Some("CmdOrCtrl+R"))?)
        .separator()
        .item(&item("new-tab", "New Tab", Some("CmdOrCtrl+T"))?)
        // Closes the tab; the frontend closes the window when only an empty tab is left.
        .item(&item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .item(&item("split-right", "Split Tab to the Right", None)?);
    if !cfg!(target_os = "macos") {
        file = file
            .separator()
            .item(&item("open-settings", "Settings…", Some("CmdOrCtrl+,"))?)
            .quit();
    }

    let edit = SubmenuBuilder::new(app, "Edit")
        .copy()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("back", "Back", Some("CmdOrCtrl+["))?)
        .item(&item("forward", "Forward", Some("CmdOrCtrl+]"))?)
        .separator()
        .item(&item(
            "toggle-sidebar",
            "Toggle Sidebar",
            Some("CmdOrCtrl+B"),
        )?)
        .item(&item(
            "toggle-backlinks",
            "Toggle Backlinks Panel",
            Some("CmdOrCtrl+Shift+B"),
        )?)
        .item(&item(
            "toggle-outline",
            "Toggle Outline Panel",
            Some("CmdOrCtrl+Shift+L"),
        )?)
        .item(&item(
            "toggle-editor",
            "Toggle Source Mode",
            Some("CmdOrCtrl+E"),
        )?)
        .separator()
        .item(&item("view-live", "Live Preview", None)?)
        .item(&item("view-source", "Source", None)?)
        .item(&item("view-reading", "Reading", None)?)
        .item(&item(
            "toggle-reading",
            "Toggle Reading View",
            Some("CmdOrCtrl+Alt+E"),
        )?)
        .separator()
        .item(&item("search", "Search Vault", Some("CmdOrCtrl+Shift+F"))?)
        .item(&item("toggle-math", "Toggle LaTeX Math", None)?)
        .item(&item(
            "cycle-theme",
            "Cycle Theme (System/Light/Dark)",
            None,
        )?)
        .separator()
        .item(&item("zoom-in", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&item("zoom-out", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom-reset", "Actual Size", Some("CmdOrCtrl+0"))?)
        .separator()
        .fullscreen()
        .build()?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(app, "Nixe")
            .about(None)
            .separator()
            .item(&item("open-settings", "Settings…", Some("CmdOrCtrl+,"))?)
            .separator()
            .item(&item(INSTALL_CLI_ID, "Install Command Line Tool…", None)?)
            .item(&item(CHECK_UPDATES_ID, "Check for Updates…", None)?)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu = menu.item(&file.build()?).item(&edit).item(&view);
    if !cfg!(target_os = "macos") {
        let help = SubmenuBuilder::new(app, "Help")
            .item(&item(CHECK_UPDATES_ID, "Check for Updates…", None)?)
            .build()?;
        menu = menu.item(&help);
    }
    if cfg!(target_os = "macos") {
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .build()?;
        menu = menu.item(&window);
    }
    menu.build()
}

pub fn forward_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit(MENU_EVENT, id);
}

/// Sets the accelerator of every menu item named in `shortcuts` (`None` removes it), looking into
/// the submenus. Ids that are no menu item are skipped, and so is an accelerator the menu cannot
/// parse: the item keeps what it had. Returns how many items changed.
pub fn apply_shortcuts<R: Runtime>(
    app: &AppHandle<R>,
    shortcuts: &HashMap<String, Option<String>>,
) -> usize {
    let Some(menu) = app.menu() else { return 0 };
    let Ok(items) = menu.items() else { return 0 };
    apply_to(items, shortcuts)
}

fn apply_to<R: Runtime>(
    items: Vec<MenuItemKind<R>>,
    shortcuts: &HashMap<String, Option<String>>,
) -> usize {
    let mut changed = 0;
    for kind in items {
        match &kind {
            MenuItemKind::Submenu(sub) => {
                if let Ok(inner) = sub.items() {
                    changed += apply_to(inner, shortcuts);
                }
            }
            MenuItemKind::MenuItem(mi) => {
                if let Some(acc) = shortcuts.get(mi.id().as_ref()) {
                    if mi.set_accelerator(acc.as_deref()).is_ok() {
                        changed += 1;
                    }
                }
            }
            _ => {}
        }
    }
    changed
}

/// The shortcuts the frontend sends, without the ones that cannot be an accelerator (empty or
/// absurdly long text); an empty one means "no shortcut".
pub fn clean_shortcuts(raw: HashMap<String, Option<String>>) -> HashMap<String, Option<String>> {
    raw.into_iter()
        .filter(|(id, _)| !id.is_empty() && id.len() <= 128)
        .map(|(id, acc)| {
            let acc = acc.filter(|a| !a.is_empty() && a.len() <= 64);
            (id, acc)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_shortcuts_drops_empty_and_oversized() {
        let mut raw = HashMap::new();
        raw.insert("a".to_string(), Some("CmdOrCtrl+K".to_string()));
        raw.insert("b".to_string(), Some(String::new()));
        raw.insert("c".to_string(), None);
        raw.insert("d".to_string(), Some("x".repeat(65)));
        raw.insert(String::new(), Some("CmdOrCtrl+J".to_string()));
        let clean = clean_shortcuts(raw);
        assert_eq!(clean.len(), 4);
        assert_eq!(clean["a"].as_deref(), Some("CmdOrCtrl+K"));
        assert_eq!(clean["b"], None);
        assert_eq!(clean["c"], None);
        assert_eq!(clean["d"], None);
    }
}
