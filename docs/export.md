# Export and print

One note for someone else. The command palette has three commands for the open note:

| Command | Does |
|---|---|
| Export as HTML | Asks for a file and writes one self-contained page. |
| Export as PDF | Opens the print dialog with the print stylesheet; choose "Save as PDF" there. |
| Print (`Ctrl/⌘+Alt+P`) | The same print dialog, for paper. |

`nixe export <note> --format html|pdf` does the same from the terminal, see [cli.md](cli.md#export).

## What the page contains

- Styles, images, the diagrams (Mermaid, as SVG) and the math (KaTeX, with its fonts) are inlined: the
  file has no script and no link to another file. Remote images keep their address.
- `![[embeds]]` of notes, headings and blocks are resolved like in the viewer.
- Wikilinks become plain text; Markdown links keep their address.
- Comments (`%%…%%`) never appear: the renderer drops them before the export sees the note.
- The properties panel and the viewer's controls (copy buttons) are left out.

## Print stylesheet

Export as PDF, Print and the `@media print` block of the HTML page share one stylesheet: no app
chrome (the page is printed from its own frame), the page size as `@page`, no break inside code,
tables, images and diagrams, and a page break before every top-level heading (`h1`) except the first
one.

## Settings

Settings, section "Export and print" (`settings.json`):

| Setting | Key | Default |
|---|---|---|
| Page break before top-level headings | `exportPageBreaks` | on |
| Dark look | `exportDark` | off |
| Page size (A3, A4, A5, Letter, Legal) | `exportPageSize` | A4 |

## Folder as a static site

The command "Export folder as site" (it asks for the folder and for where to write) and
`nixe export <folder> --site <out> [--exclude <dir>]...` write a vault, or a part of it, as a website:

- One HTML page per note (`folder/Note.md` becomes `folder/Note.html`), with the frontmatter left out.
  A top-level `index.md` is the home page; without one, `index.html` lists the notes.
- `[[wikilinks]]` and Markdown links to notes become links between the pages, headings included.
  A link to a note that is excluded, missing, ambiguous or outside the exported folder is plain text.
  `![[image]]` shows the image; other embeds become a link. Files a page shows or links are copied.
- Every page has the navigation tree of all pages, the backlinks of the note, and a search box
  (`_nixe/search-index.js` and `_nixe/search.js`, no server).
- Excluded: a folder named by `--exclude` (relative to the exported folder or to the vault) and every
  note with `publish: false` (or `no`) in its frontmatter.
- Every link is relative and the output has no server part: it works from a subpath (GitHub Pages) and
  from `file://`. The file `.nojekyll` keeps GitHub Pages from dropping the `_nixe` folder.
- Raw HTML in a note is shown as text. Mermaid diagrams stay code blocks, math stays source text and
  embedded notes become links.

## Limits

- A PDF is made by the print dialog of the system web view, not by Nixe, so the command line cannot
  write one without that dialog.
- In a development build (`pnpm tauri dev`) the KaTeX fonts come from the dev server and are not
  inlined; a release build embeds them.
