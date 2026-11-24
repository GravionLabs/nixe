# ADR 0009: EPUB reader: foliate-js, sandbox and storage

- Status: Proposed
- Date: 2026-11-24
- Issues: #460 (PBI #484)

## Context

Nixe is to read EPUB books next to the notes: open a book, keep the reading position, and take
highlights and quotes into the vault. Four questions have to be settled before the reader is built:
which library renders the book, how an untrusted book is kept away from the app, how the files
reach the WebView, and where books and reading data live.

An EPUB is a zip of XHTML, CSS and images and may contain scripts. The WebView of Nixe has access
to the Tauri commands, so a book must never run in the context of the app. The content security
policy (`tauri.conf.json`) allows no frames today.

## Decision

### Library: foliate-js

The reader uses [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT) and not epub.js.

- **Maintenance:** foliate-js is maintained as the engine of the Foliate reader; epub.js has had
  little development for years.
- **Pagination and CFI:** paginated and scrolled layout and EPUB CFI (the stable position inside a
  book, used for the reading position and highlights) are built in.
- **Licence:** MIT, compatible with Nixe.
- **Size:** small, plain ES modules without a build step or large dependencies.

foliate-js relies on features of the WebView (CSS columns, `Range`, `ShadowRoot`). WebKitGTK, the
WebView on Linux, was checked in #485; see [WebKitGTK check](#webkitgtk-check-485).

### Sandbox

The book renders in an `iframe` whose `src` is a `blob:` URL made from the book content.

- The CSP gets `frame-src blob:`; no other frame source is allowed.
- The `iframe` carries a `sandbox` attribute without `allow-scripts`: no script of the book runs.
  foliate-js adds `allow-scripts` itself; a pnpm patch (`patches/foliate-js@1.0.1.patch`) removes it
  (#487, see the finding in the [WebKitGTK check](#webkitgtk-check-485)).
  The reader itself (foliate-js) runs in the app and reads and styles the content from outside.
  The frame gets `allow-same-origin` so that the reader can reach its document; this is safe only
  because scripts stay off, and `allow-scripts` must never be added together with it.
- The book has no access to the Tauri commands or to the origin of the app.

### Files are read through the Rust core

The WebView never opens a book file directly. A Tauri command of the Rust core reads the file and
returns the bytes; the frontend builds the `blob:` URLs from them. The core checks the path against
the roots of the workspace, as for every other file access (see
[backend/tauri-commands.md](../backend/tauri-commands.md)). The `asset:` protocol is not used for
books.

### Storage

- **Books** live in a library folder outside the vault. The folder is added as a workspace root, so
  the books show up in the sidebar and the search. It is synced by a file sync service (OneDrive,
  iCloud, Syncthing), not by git: books are large binaries and would bloat the history of a vault.
- **Reading position, highlights and quotes** are text in the vault (Markdown and frontmatter), so
  they are versioned and synced with the vault like every note and stay readable without Nixe.
  The position is stored as a CFI.
- **Remote URLs** are downloaded to a folder outside git (the library folder or the app data
  directory), never into the vault.

## WebKitGTK check (#485)

foliate-js 1.0.1 in WebKitGTK 2.52.6 (Linux), on a page with the CSP of `tauri.conf.json` set as a
`<meta>` policy (`frame-src blob:`, `script-src 'self'`), outside the Tauri shell:

- **Rendering works.** `makeBook` opens `fixtures/books/sample.epub` (title, spine, table of
  contents); `<foliate-view>` renders the first chapter in paginated layout (CSS columns) and in
  scrolled layout, and paging forward fires `relocate`.
- **The CSP holds inside the book frame.** A test book with an inline `<script>`, a `<script src>`
  from the book and an `onclick` attribute ran none of them: the `blob:` document inherits the
  policy of the app.
- **Finding: foliate-js sets `sandbox="allow-same-origin allow-scripts"` itself** on its iframes
  (`paginator.js`, `fixed-layout.js`), because events do not reach a sandboxed frame without
  `allow-scripts` in WebKit ([WebKit bug 218086](https://bugs.webkit.org/show_bug.cgi?id=218086)).
  The [Sandbox](#sandbox) decision above (no `allow-scripts`) does not hold with the library as it
  is; what keeps book scripts out is the CSP (`script-src 'self'`, no `'unsafe-inline'`, no
  `blob:`), which foliate-js also names as required. The Sandbox section has to be revised before
  the reader tab (#487).
- **Finding: the stylesheets of a book are blocked.** foliate-js loads them as `blob:` URLs, and
  `style-src` allows only `'self' 'unsafe-inline'`; with `blob:` added to `style-src` the book CSS
  applies. Images load (`img-src` already allows `blob:`). Whether `style-src` gets `blob:` is open
  for #487; #485 changes only `frame-src`.

## Alternatives

- **epub.js:** widely used, but little maintained; pagination and CFI are less robust.
- **Render the book directly in the app document:** the scripts and styles of the book would run
  with the rights of the app.
- **`asset:` protocol or `file:` URLs for the book files:** the WebView would read the file system
  directly and bypass the root check of the Rust core.
- **Books inside the vault:** git would store every book in the history.
- **Reading data in the app data directory:** it would not sync with the vault and not be readable
  as text.

## Consequences

- A dependency (foliate-js) joins the frontend; its licence and updates are tracked like the others.
- The CSP changes by `frame-src blob:`; this is the only widening and is covered by a test.
- A malicious book cannot run code or reach the Tauri commands; it can only render its markup and
  styles in the sandboxed frame.
- Books are not in git: a user needs a file sync service to have them on a second device. The
  highlights and quotes in the vault stay valid because they carry the CFI and the book name.
- Following issues implement the reader, the CSP change, the command that reads books and the
  storage of position, highlights and quotes; the user docs are written with them.

## Decision of #487

- The sandbox of the Sandbox section holds: the reader patches foliate-js so that its frames get
  `sandbox="allow-same-origin"`. `e2e/epub.e2e.ts` proves in Chromium that a script and an `onclick`
  of a book do not run.
- `style-src` keeps `'self' 'unsafe-inline'`: the stylesheets of a book stay blocked for now, the book is
  shown with the styles of the reader. Whether `blob:` joins `style-src` is left to the theme issue (#490).
