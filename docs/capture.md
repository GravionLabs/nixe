# Capture from anywhere

A global shortcut opens a small always-on-top window, also when Nixe has no window open. The
text goes to today's daily note or becomes a new note in the inbox folder.

## Settings

Settings page, section **Capture** (keys in `settings.json`):

| Key | Meaning |
|---|---|
| `captureShortcut` | Global shortcut as a Tauri accelerator, for example `CommandOrControl+Shift+Space`. Empty (the default) turns capture off. |
| `captureTarget` | `daily` (default): appended to today's daily note. `inbox`: a new note per capture. |
| `captureInbox` | Vault-relative inbox folder. Empty: the new-note folder of the vault, else `Inbox`. |
| `captureTemplate` | Vault-relative template note of a new inbox note. `{{content}}` marks the text; without it the text follows the template. `{{title}}`, `{{date}}` and `{{time}}` work too. |

The daily note is found like `nixe daily` does: `.nixe/config.json` (`daily`) first, else `.obsidian/daily-notes.json`, the daily
notes keys of the app settings for what it leaves out. A missing daily note is created from its
template. An inbox note is named `YYYY-MM-DD HHmmss.md` (` 2`, ` 3`… when it exists).

The vault is the folder the app had open last (`lastFolder`).

## Window

- **Enter** saves, **Escape** discards, **Shift+Enter** adds a line.
- **`[[`** lists note names; arrow keys choose, Enter or Tab completes.
- **Ctrl/Cmd+Shift+V** inserts the clipboard. A URL becomes `[title](url)` when the page title
  can be fetched within two seconds, else the bare URL stays.

- **Alt+Enter** saves a URL as a link note. When the text is one URL (`http` or `https`, nothing
  else), the window shows "Alt+Enter: save as link"; Enter still saves the text as above. The
  note is made like `nixe clip` makes it (see [links.md](links.md)), with the archive that
  `links.archive` asks for. A URL that a link note holds already shows "already saved" with the
  path of that note. A page that cannot be fetched still becomes a link note with the URL as
  title, and the window says so. The window closes after the save, a moment later when it has
  something to say. An error (no vault, a note that cannot be written) stays in the window with
  the text.

The window is a second webview of the same frontend (`index.html#capture`). It is created hidden
when the shortcut is registered, so the shortcut only shows it; closing it hides it again.

## Running without a window

With a shortcut set, a tray icon (New capture, Open Nixe, Quit) keeps Nixe running when the main
window closes, so the shortcut keeps working. Quit it from the tray menu. Without a shortcut Nixe
quits with its last window as before.

## Saving and sync

The text is written with the atomic write of the editor (temporary file, then rename), confined
to the vault root. A running window sees the change through its file watcher. The next
auto-sync of a running Nixe window commits and pushes it; with the main window closed nothing
syncs until Nixe is opened again.

An invalid shortcut is reported in a toast and leaves capture off.
