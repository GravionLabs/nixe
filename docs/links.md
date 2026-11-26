# Links

Links turns the vault into a bookmark library: every saved web page is one Markdown note with
`type: link`. The decisions are in [ADR 0010](adr/0010-links-a-bookmark-library-in-the-vault.md).
This page is the convention that the CLI, the capture window, the browser extension, the MCP tool
and the importers all follow.

## The link note

```markdown
---
type: link
url: https://example.com/articles/vault-first
title: Example Article
tags:
  - reading
saved: 2026-11-20T09:30:00+01:00
status: unread
description: A short article about keeping notes as plain files.
image: https://example.com/images/vault-first.png
site: example.com
---

> A short article about keeping notes as plain files.

## Notes

## Archive

# Keeping notes as plain files

The reader text of the page as Markdown.
```

### Frontmatter

| Key | Required | Value |
|---|---|---|
| `type` | yes | always `link` |
| `url` | yes | the address of the page, `http` or `https` |
| `title` | yes | the title of the page |
| `tags` | yes | a list; empty when the page has none |
| `saved` | yes | when the link was saved, ISO 8601 with offset (`2026-11-20T09:30:00+01:00` or `…Z`) |
| `status` | yes | `unread` or `read`; a new link is `unread` |
| `description` | no | the description of the page (meta description) |
| `image` | no | the URL of the preview image |
| `site` | no | the name or host of the site |
| `archive` | no | a list of archive files next to the note, relative to its folder (`.archive/<note stem>.html`); only when `links.archive` asked for them and the file was written |

An optional key that is empty is left out, not written empty.

### Body

1. **Description quote:** the description as a block quote, when there is one.
2. `## Notes`: the user's own notes; always present, may be empty. A tool never overwrites it.
3. `## Archive`: the reader text of the page as Markdown. Present on every link note; empty when
   the page was not archived.

The order is fixed so that tools can find the sections by heading.

### File name

The file name is the title plus `.md`. The title is sanitized like `cli_write::note_file_name`
(`src-tauri/src/cli_write.rs`): surrounding whitespace is trimmed, a trailing `.md` is not doubled,
and the characters `\ / : * ? " < > | # ^ [ ]` and control characters are not allowed in a file name
(the tool replaces them; a title that is empty afterwards falls back to the host of the URL). When
a note of that name exists in the folder, ` 2`, ` 3`, … is appended to the name before `.md`
(`Example Article 2.md`). The frontmatter `title` keeps the original title.

### One note per URL

Before a note is written, the URL (the one given, then the canonical one of the page) is
normalized by `links::url::normalize` and looked up among the `type: link` notes through the
index (`url` property). The normal form lowercases scheme and host, drops the default port, the
fragment and the trailing slash of the path, sorts the query parameters and removes the tracking
parameters (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref`, `igshid`; the constant
`TRACKING_PARAMS`). The note stores the normalized URL in `url`. On a match nothing is fetched or
written: `clip` returns `created: false` with the path of the existing note, and `nixe clip`
prints `exists: <path>` (exit code 0; `--open` opens that note).

## Folders

- **Role `links`:** `.nixe/config.json` → `folders.links`; without an entry the folder is `Links/`
  (see [ADR 0007](adr/0007-vault-configuration-in-nixe.md)). Tools resolve it through the role.
- **Collections:** a subfolder of the links folder is a collection (`Links/Recipes/`). A link note
  may sit in any subfolder; the collection is the folder, not a property.
- **`Links/.archive/`:** optional copies of a page next to the reader text, in the `.archive/`
  folder of the folder that holds the note. The folder is gitignored and not synced by Git; use a
  file sync service for it if the files are wanted on other devices. A link note refers to such a
  file by name (`archive` in the frontmatter) only when the file was written on this device.

### The archive setting

`links.archive` in `.nixe/config.json` is a list of the copies a clip stores besides the Markdown
note: `html`, `screenshot`, `pdf`. The default is `[]` (Markdown only). An unknown entry is
ignored with a warning in the log. `screenshot` and `pdf` are made by the desktop app only (below).

```json
{ "links": { "archive": ["html"] } }
```

With `html`, `nixe clip` writes `<folder>/.archive/<note stem>.html`: the page as one file, with
images and style sheets (also their `url(…)`) inlined as data URIs and scripts, event handlers, `javascript:` addresses, frames and meta refresh removed
(`src-tauri/src/links/archive.rs`). An asset that cannot be fetched, is larger than 2 MiB
(`MAX_ASSET_BYTES`) or would take the file over 10 MiB (`MAX_ARCHIVE_BYTES`) stays a link to its
absolute address; a page that is larger than 10 MiB on its own gets no file. A copy that fails
never fails the clip: the note is saved without `archive` and the clip prints a warning.

Before the first file of a folder is written, `<folder>/.archive/` is appended to the `.gitignore`
of the vault when Git does not ignore it yet (`git::gitignore_ensure`; the file is appended to,
never rewritten, under the `# Nixe` comment of [vault-git.md](vault-git.md)).

### Screenshot and PDF (desktop app)

With `screenshot` or `pdf`, the app (command `clip_link`, `src-tauri/src/links/render.rs`) loads the
page in a hidden webview, waits for the load event plus 1.5 s, and stores
`<folder>/.archive/<note stem>.png` (viewport width 1280, the full page) and/or `.pdf` next to the
HTML copy; the files are named in `archive`. The webview follows the rule of the web tab (#461): no
capability file names its label (`link-render-*`), so the page has no IPC, and it runs in a private
session without the cookies or storage of the app. A format that the platform cannot make, a page
that does not load within 30 s or a file that cannot be written is logged and skipped; the clip
still succeeds with a warning.

`nixe clip` has no webview: it saves the note (and the `html` copy) and prints
`the screenshot and pdf archive is made by the desktop app only; skipped` as a warning.

| Platform | Engine | Screenshot | PDF |
|---|---|---|---|
| Linux | WebKitGTK | `webkit_web_view_get_snapshot`, full document | GTK print operation to a file |
| macOS | WKWebView | not wired yet (`takeSnapshot`) | not wired yet (`createPDF`) |
| Windows | WebView2 | not wired yet (`CapturePreview`) | not wired yet (`PrintToPdf`) |

## Links view

The **Links** button of the activity bar (command "Show links", in a vault) opens a tab with all
`type: link` notes of the vault, the newest `saved` first. The tab is restored with the layout. The
list is a [base](bases.md) answered from the index
(`src/app/features/links/links-base.json`), so it follows changes in the vault.

- **Unread** (the default) is the inbox: every link whose `status` is not `read`. **All** shows
  every link and adds the status filter.
- **Cards** show the image, title, site and tags; the **table** has the columns title, site, tags,
  saved and status.
- **Collection** is the folder below the links folder, with its sub folders; for a link note outside
  the links folder it is its folder in the vault. **Tag** is one of the `tags` of the links,
  without regard to case.
- **Mark read** / **Mark unread** writes `status` into the frontmatter of the note, like a
  [cell of a base](bases.md#editing-cells).
- A click on a link opens its note in a tab. Ctrl+click (Cmd+click on macOS) opens its `url` in the
  system browser; only `http` and `https` addresses are opened.

## Browser extension host

`nixe native-host` is the Native Messaging host of the browser extension. The browser starts it;
it reads and writes frames on stdin and stdout: a 32-bit length in native byte order, then that
many bytes of UTF-8 JSON. It is not meant to be run by hand.

| Message | Answer |
|---|---|
| `{type: "clip", url, title?, html?, tags?, folder?, vault?}` | `{ok: true, path, created, vault}` (`path` is vault-relative) or `{ok: false, error}` |
| `{type: "vaults"}` | `{ok: true, vaults: [{name, path, folder, folders}]}`: `folder` is the links folder, `folders` its sub folders |

- `clip` does what `nixe clip` does: `html` is read like the file of `--html`, a URL that a link
  note holds already gives that note (`created: false`).
- The host writes only into the vaults of the saved workspaces (`vault` is a name or a path of one
  of them; without it the first) and `folder` must be the links folder or below it.
- A message over 8 MiB (`MAX_MESSAGE_BYTES`) is answered with an error and ends the session; an
  unknown `type` answers an error.

**Install:** the menu item "Install browser extension support…" (Nixe menu on macOS, Help menu
elsewhere) writes a small launcher (`nixe-native-host`, `.cmd` on Windows) into the app data
directory and the host manifest `app.gravionlabs.nixe` for each installed browser. Running it
again rewrites the same files.

| | Chrome, Edge, Brave | Firefox |
|---|---|---|
| Manifest field | `allowed_origins` (`chrome-extension://<id>/`) | `allowed_extensions` |
| Linux | `~/.config/google-chrome`, `microsoft-edge`, `BraveSoftware/Brave-Browser` `/NativeMessagingHosts/` | `~/.mozilla/native-messaging-hosts/` |
| macOS | `~/Library/Application Support/{Google/Chrome, Microsoft Edge, BraveSoftware/Brave-Browser}/NativeMessagingHosts/` | `~/Library/Application Support/Mozilla/NativeMessagingHosts/` |
| Windows | manifest in the app data directory, key `HKCU\Software\{Google\Chrome, Microsoft\Edge, BraveSoftware\Brave-Browser}\NativeMessagingHosts\app.gravionlabs.nixe` | key `HKCU\Software\Mozilla\NativeMessagingHosts\app.gravionlabs.nixe` |

On Linux and macOS a browser whose profile folder does not exist is skipped. The extension IDs
are the constants `ALLOWED_CHROMIUM_EXTENSIONS` and `ALLOWED_FIREFOX_EXTENSIONS` in
`src-tauri/src/native_host.rs`; they still hold placeholders until the extension is published.

## Browser extension

The extension (`extension/`, one MV3 code base for Chromium and Firefox; `pnpm --filter
nixe-extension build` writes `extension/dist/<browser>/`) saves the current tab through the
native host above.

- **Toolbar popup:** the title (editable), tags (comma separated), the folder (the links folder of
  each vault and its sub folders, from `{type: "vaults"}`) and Save. It answers "Saved: <note>" or
  "Already saved: <note>".
- **Rendered HTML:** Save reads `document.documentElement.outerHTML` of the tab with
  `scripting.executeScript`, so a page behind a login is saved as you see it. This happens only on
  that click: the extension holds `activeTab`, no host permission.
- **Context menu:** "Save link to Nixe" on a link saves that URL without HTML; the result shows as
  a badge on the toolbar button.
- **Host missing:** when the browser cannot find the native host, the popup says so and links to
  this section; install it with "Install browser extension support…" (see above).

## Example notes

`fixtures/vault/Links/` has two link notes that the Rust and TypeScript tests use: `Example
Article.md` (read, with an archive) and `Unread Page.md` (unread, no archive).

## Import

`nixe import-links <file>` creates link notes from a browser bookmark export, a Pocket export, a Raindrop CSV or a Linkwarden JSON backup
(see [cli.md](cli.md)). Folders become subfolders, dates `saved`, tags tags; the code is in
`src-tauri/src/links/import/` and the test files in `fixtures/import/`.
