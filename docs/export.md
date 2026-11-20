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

## Limits

- A PDF is made by the print dialog of the system web view, not by Nixe, so the command line cannot
  write one without that dialog.
- In a development build (`pnpm tauri dev`) the KaTeX fonts come from the dev server and are not
  inlined; a release build embeds them.
