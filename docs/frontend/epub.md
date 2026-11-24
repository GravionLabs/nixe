# EPUB reader

A book opens as a tab with the view `epub` (ADR [0009](../adr/0009-epub-reader-foliate-js-sandbox-and-storage.md)). The tab shows the table of contents at the side and the book, paged or scrolled. Opening a book from a link and the file tree is described below; the reading position, the theme and zoom come with later issues.

## Parts

| Part | What it does |
| --- | --- |
| `core/epub/epub.service.ts` | `load(path)` reads the bytes with the Rust command `read_epub` (vault or open roots only) and parses them with foliate-js `makeBook`. It also keeps the reading mode (`paginated` or `scrolled`) in `localStorage`. |
| `core/epub/epub.ts` | The book type, the title of a book and the table of contents as a flat list. |
| `TabsService.openEpub(path)` | Reads the book first (a book that cannot be read opens no tab), then opens a tab with the view `epub`; the tab that shows the book already is focused. The tab title is the book title. The tab is not stored with the layout. |
| `features/epub/` | `EpubComponent`: the header with the title and the mode switch, the table of contents, the `<foliate-view>` and the page buttons. |

## Opening a book

A link to a file with the extension `.epub` opens the reader tab instead of the system app (`isEpubPath` in `core/markdown/paths.ts`):

- a wikilink, `[[Books:Title.epub]]`: the root prefix and the vault are resolved as for a note (`WorkspacesService.resolveLink`, so a link into another root works);
- a Markdown link, `[Title](Books/Title.epub)`, relative to the note as for every local link;
- a click in the file tree (also with Alt; a double click has nothing more to do).

The viewer and the editor do the same. A book that does not exist shows `File not found: <target>`, as a missing Markdown link does, and a wikilink to a missing book creates no note. A book that cannot be read shows the error of the reader. Every other file that is not Markdown keeps opening in the system app. Specs: `features/epub/epub-links.spec.ts` and `features/sidebar/sidebar.component.spec.ts`.

## Keys

With the focus in the reader (or in the book): Page down, Arrow right, Arrow down and Space turn to the next page; Page up, Arrow left, Arrow up and Shift+Space turn back. In scrolled mode foliate-js scrolls and moves on to the next chapter at the end.

## Sandbox

foliate-js renders each chapter in an `iframe` with a `blob:` URL. Upstream gives the frame `sandbox="allow-same-origin allow-scripts"`, because of a WebKit bug with events. Nixe takes `allow-scripts` out with the pnpm patch `patches/foliate-js@1.0.1.patch`, so a script or an `onclick` of a book never runs. The CSP (`frame-src blob:`, `script-src 'self'`) is the second line.

- `src/app/features/epub/foliate.spec.ts` fails when the patch is not applied.
- `e2e/epub.e2e.ts` opens `fixtures/books/script.epub` (an inline script and an `onclick`) in Chromium and proves that neither runs and that the frame has no `allow-scripts`.
- When Renovate raises foliate-js, the patch has to be made again (`pnpm patch foliate-js`); the two tests above fail until it is.
- The WebKit bug 218086 says events do not reach a frame without `allow-scripts`. Check the keys and the touch gestures in the book on WebKitGTK and macOS WebKit when the reader changes.

## Demo and tests

The demo build answers `read_epub` with `fixtures/books/sample.epub` (`src/demo/nixe/book.ts`). With `ng serve` and the demo build `window.__nixeDev.openEpub(path)` opens a book (the links and the file tree open books as well); the release build has no such function. Specs: `core/epub/*.spec.ts`, `core/tabs/tabs.service.spec.ts`, `features/epub/*.spec.ts` and the e2e test.
