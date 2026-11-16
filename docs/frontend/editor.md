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
  temp file in the same folder, then rename; the Rust side decides which paths are allowed (vault
  root, or the folder of the open note). CRLF notes keep CRLF; notes with invalid UTF-8 are not editable.
- **External changes**: the watcher cannot tell who wrote, so every text about to be written is
  tracked: the text editor and disk agree on, plus writes in flight or finished within 2 s, are ignored; anything else (even an older text restored by `git checkout`) is foreign. A foreign change is loaded at once
  when nothing is unsaved; otherwise a bar offers *Reload* or *Keep mine*, and saving is paused
  until one is chosen. The editor cannot be closed meanwhile; switching note or closing the window saves unsaved text to `<name> (unsaved copy).md` instead of overwriting the note.
- **Scroll**: the viewer's top block (`data-line`) becomes the editor's first line and back.

## Creating, renaming and deleting notes

`VaultOpsService` (`core/workspace/`) wraps the Rust commands `create_file`, `create_dir`,
`rename_path` and `trash_path`, which refuse any path outside the vault root.

- **⌘/Ctrl+N** creates `Untitled.md` (`Untitled 1.md` … when taken) in the folder of
  `.obsidian/app.json` (`newFileLocation` `folder` + `newFileFolderPath`, or `current` for the
  folder of the open note), otherwise the vault root, and opens it in the editor.
- A click on an **unresolved wikilink** creates its target by the same rule (a `folder/Name`
  target is created at that path); the quick switcher creates a note from the query when
  nothing matches.
- The **sidebar context menu** (right click, F2 renames inline) offers New note, New folder,
  Rename, Delete and Reveal in Finder/Explorer. Delete moves to `.trash/` of the vault.
- Links are not rewritten when a note is renamed.
