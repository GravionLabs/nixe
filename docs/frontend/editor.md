# Editor

⌘/Ctrl+E (View → Toggle Editor) swaps the viewer for a CodeMirror 6 editor of the open note.
`EditorComponent` is rendered inside `@defer`, so the CodeMirror chunk loads on first use.

- **Logic**: `core/editor/editor-core.ts` has no framework imports: `AutoSaver` (debounce),
  `ExternalChangeTracker`, the scroll mapping and the `[[wikilink]]` / `#tag` scanner.
  `EditorService` switches between viewer and editor.
- **Styling**: Lezer Markdown nodes get `cm-md-*` classes (heading sizes, bold, italic, code,
  dimmed syntax characters); wikilinks and tags get `cm-wikilink` / `cm-tag`. Colors are the app's
  CSS variables, the font size follows the zoom. ⌘/Ctrl+click on a wikilink opens the note.
- **Saving**: ⌘/Ctrl+S writes at once; otherwise 1 s after the last change, on blur, on note
  switch, when the editor closes and when the window closes. The write is `write_text_file`:
  temp file in the same folder, then rename, and a path outside the vault root (or the note's
  folder when it lies outside the vault) is refused.
- **External changes**: the watcher cannot tell who wrote, so every text about to be written is
  remembered and a disk text equal to one of them is ignored. A foreign change is loaded at once
  when nothing is unsaved; otherwise a bar offers *Reload* or *Keep mine*, and saving is paused
  until one is chosen (a pending save is never written over an unresolved change).
- **Scroll**: the viewer's top block (`data-line`) becomes the editor's first line and back.
