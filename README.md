# Nixe

Cross-platform Markdown viewer for macOS, Windows, and Linux. Built with [Tauri 2](https://tauri.app) and Angular.

## Features

- **Markdown** (CommonMark + GFM): tables, task lists, footnotes, syntax highlighting
- **Mermaid**: as a ```` ```mermaid ```` code block and in the **Azure DevOps wiki format**
  ```
  ::: mermaid
  graph LR
    A --> B
  :::
  ```
  Invalid diagrams are shown as an error box with the message and the source.
  Click a diagram to open it in a zoomable dialog, with zoom buttons in the dialog and scroll-to-zoom.
- **LaTeX** via KaTeX: `$…$`, `$$…$$`, ```` ```math ````. Can be turned off in the toolbar.
- **Links**:
  - external: opens in the system browser
  - anchors `#section`
  - relative `.md` files, with back/forward navigation
  - other files: open with the default app
- **Azure DevOps wiki**:
  - wiki-absolute links `/Page/Sub-Page`: `-` stands for a space, `%2D` for a literal hyphen
  - images from `/.attachments/…`
  - `[[_TOC_]]`
  - The wiki root is the topmost folder with a `.order` file, otherwise the Git root.
- **Open folder**: a file tree of Markdown files on the left. It loads lazily, its width is adjustable, and it expands to the active file as you navigate. In ADO wikis the `.order` sequence is used, `Page.md` and the folder `Page/` appear as a single node, and names are decoded (`Data-Flow.md` → "Data Flow"). The last opened folder is restored on startup.
- **Native menu**: File (Open file, Open folder, Reload), Edit, View
- **Live reload** when the file changes on disk
- **Light/dark**: follows the system or can be set manually
- Open via menu/dialog, drag & drop, command line (`nixe README.md`, `nixe ./docs`), or file association

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘/Ctrl + O | Open file |
| ⌘/Ctrl + ⇧ + O | Open folder |
| ⌘/Ctrl + R | Reload |
| ⌘/Ctrl + B | Toggle sidebar |
| ⌘/Ctrl + [ / ] or Alt + ← / → | Back / forward |
| ⌘/Ctrl + = / - / 0 or ⌘/Ctrl + scroll or toolbar buttons | Zoom in / out / reset |

## Development

Prerequisites:
- Node 24 (`nvm use`)
- Rust (`rustup`)
- platform-specific Tauri prerequisites, see <https://tauri.app/start/prerequisites/>. On Linux, e.g. `libwebkit2gtk-4.1-dev`.

```bash
pnpm install
pnpm tauri dev                                       # start the app
pnpm tauri dev -- -- -- "$PWD/fixtures"              # start with a folder (or file)
pnpm test                                            # unit tests (Markdown core)
cargo test --manifest-path src-tauri/Cargo.toml      # Rust tests
pnpm tauri build                                     # installer for the current platform
```

`fixtures/` contains test documents for all features, including a small ADO wiki tree.

Release builds for macOS (arm64/x64), Windows, and Linux are produced by `.github/workflows/release.yml`. Pushing a `v*` tag creates a draft release.

## Structure

```
src/app/core/markdown/   Markdown core (framework-free, tested with Vitest)
  markdown-renderer.ts   markdown-it + plugins
  plugins/               ADO Mermaid, Mermaid fence, [[_TOC_]], data-line
  link-resolver.ts       link classification & path resolution (incl. ADO rules)
  mermaid-renderer.ts    Mermaid (lazy-loaded, SVG cache)
  markdown.service.ts    DOMPurify + image paths → Tauri asset protocol
src/app/core/workspace/  file tree (tree-model.ts is framework-free and tested)
src/app/core/file/       DocumentService (file, history), backend calls
src/app/features/        toolbar, sidebar, viewer
src-tauri/src/lib.rs     file I/O, watcher, wiki root, CLI/file opening, single instance
src-tauri/src/menu.rs    native menu → `menu` event to the frontend
src-tauri/src/tree.rs    directory listing sorted by .order
```

## Outlook: VS Code extension

The Markdown core (`core/markdown/*` except `markdown.service.ts`, plus `core/workspace/tree-model.ts`) depends on neither Angular nor Tauri. For a VS Code extension it can be extracted into its own package and plugged into the built-in preview via `markdown.markdownItPlugins`, or used in a custom webview. It already emits the `data-line` attributes needed for scroll sync.
