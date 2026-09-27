//! Native application menu. Custom items are forwarded to the frontend as a
//! `menu` event carrying the item id.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub const MENU_EVENT: &str = "menu";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accelerator: Option<&str>| {
        let builder = MenuItemBuilder::with_id(id, label);
        match accelerator {
            Some(acc) => builder.accelerator(acc).build(app),
            None => builder.build(app),
        }
    };

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item("open-file", "Open File…", Some("CmdOrCtrl+O"))?)
        .item(&item("open-folder", "Open Folder…", Some("CmdOrCtrl+Shift+O"))?)
        .separator()
        .item(&item("reload", "Reload", Some("CmdOrCtrl+R"))?)
        .separator()
        .close_window();
    if !cfg!(target_os = "macos") {
        file = file.quit();
    }

    let edit = SubmenuBuilder::new(app, "Edit").copy().select_all().build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("back", "Back", Some("CmdOrCtrl+["))?)
        .item(&item("forward", "Forward", Some("CmdOrCtrl+]"))?)
        .separator()
        .item(&item("toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B"))?)
        .item(&item("toggle-math", "Toggle LaTeX Math", None)?)
        .item(&item("cycle-theme", "Cycle Theme (System/Light/Dark)", None)?)
        .separator()
        .fullscreen()
        .build()?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(app, "Nixe")
            .about(None)
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
    if cfg!(target_os = "macos") {
        let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
        menu = menu.item(&window);
    }
    menu.build()
}

pub fn forward_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit(MENU_EVENT, id);
}
