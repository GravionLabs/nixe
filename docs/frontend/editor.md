# Editor

The *Edit* toggle in the toolbar, ⌘/Ctrl+E and View → Toggle Editor all run the `toggle-editor` command and swap the viewer for a CodeMirror 6 editor of the open note.
The toolbar button shows `editing()` as `active`/`aria-pressed` and is disabled without an open note or while `EditorService.blocked()` (unresolved external change) holds the editor open.
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

## Folding

Headings, list items and the frontmatter fold in the editor; headings also fold in the reading view.

- **Editor**: a gutter marker (▾ / ▸) next to every foldable line, and the commands *Fold at the cursor*, *Unfold at the cursor*, *Fold all* and *Unfold all* (palette; keys `Ctrl+Shift+[` / `]` in the editor). A heading folds down to the next heading of its level or a higher one, a list item with its deeper lines, the frontmatter between its `---` lines. Code fences are skipped. Code: `features/editor/folding.ts` (CodeMirror `foldService`), ranges from the pure `core/fold/fold-core.ts`.
- **Reading view**: a marker left of each heading with content; clicking it hides the blocks below (`core/fold/viewer-folds.ts`). The same four commands act in the reading view on the heading at or above the top of the view (*fold all* on every heading); list items and the frontmatter stay open there.
- **Remembered per note**: the folded start lines are kept in `folds.json` in the app data directory (commands `read_folds` / `write_folds`, `folds.rs`), keyed by the path of the note, never in the vault. Editor and reading view share them; a line that no longer folds after the note changed is ignored. A file that cannot be read is not overwritten.

## Find and replace

- **Editor**: ⌘/Ctrl+F opens the `@codemirror/search` bar at the top (next, previous, match count,
  case, regex, whole word); ⌘/Ctrl+⌥+F opens it with the replace field, *replace* and *replace all*.
  Escape closes the bar and returns the focus to the text. The bar uses the app's CSS variables.
- **Reading view**: ⌘/Ctrl+F (the `find` command) opens a bar in `ViewerComponent` that wraps the
  matches of the rendered note in `<mark class="find-hit">` and scrolls to the current one
  (Enter / Shift+Enter, ↑ / ↓). Diagrams are skipped; a match never crosses a block. The pure
  matcher is `core/find/find-core.ts`. Escape closes the bar and removes the highlights.

## Autocomplete

`features/editor/completion.ts` (sources) and `core/editor/completion-core.ts` (pure logic) add
CodeMirror completion for links and tags; nothing is offered in code.

- `[[` lists the notes of the vault, fuzzy over file names and aliases. Choosing an alias inserts
  `[[Note|Alias]]`. `[[Note#` lists the headings of the note (`[[#` those of the open note) and
  `[[Note#^` its block ids (`^id` at the end of a line); both are read from the note's text, so
  unsaved edits of the open note count. The link is closed with `]]`.
- The note part follows `newLinkFormat` of `.obsidian/app.json` (`shortest`, `relative`,
  `absolute`; the `link_format` command reads it, the same reader the rename relinking uses).
- `#` at a word start lists the vault's tags (the `tags` command) by frequency, filtered fuzzily.

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
- Renaming or moving a note or folder rewrites the links to it in the notes that contain them
  (`[[wikilinks]]`, `![[embeds]]` and Markdown links), like Obsidian's `alwaysUpdateLinks`.
  Aliases, headings and block references stay; the path form follows `newLinkFormat` of
  `.obsidian/app.json` (`shortest`, `relative`, `absolute`). A folder rename first lists the notes
  that change and asks for confirmation. The Rust core reads the notes that link to the renamed
  files from the index, renames, and writes all of them at once, so the watcher reports one batch.
  Links in the frontmatter, code spans, fenced code and `%%comments%%` are left alone, and a
  `relative` link is written as Obsidian does but the index only resolves it by name for now.

## Templates

The command `Insert template` (open in the editor) lists the Markdown files in the template folder and inserts the chosen one at the cursor.

- **Folder:** `folder` of `.obsidian/templates.json` (`template_folder`), else the setting `templateFolder`.
- **Variables** (`core/templates/template-core.ts`): `{{title}}` (note name), `{{date}}`, `{{time}}`, `{{date:FORMAT}}` and `{{time:FORMAT}}`. `FORMAT` uses Moment tokens in English (`YYYY MM DD Do dddd HH hh mm ss A Q W Z X …`, text in `[brackets]` stays). Without a format: `YYYY-MM-DD` and `HH:mm`; `dateFormat` and `timeFormat` of `templates.json` are not read. Other `{{…}}` text stays.
- **Frontmatter:** the template's frontmatter is merged into the note's, not inserted in the body. The note keeps its own values; empty ones and missing properties come from the template; lists are joined without duplicates. A note with invalid frontmatter is refused.

## Daily notes

`Open today's daily note` (`Mod+Shift+D`) opens the note of today and creates it first when it does not exist; `Open previous daily note` and `Open next daily note` open the nearest existing daily note before or after the open one (before or after today when the open note is none). Code: `core/daily/`.

- **Settings:** `folder`, `format` and `template` of `.obsidian/daily-notes.json` (`daily_notes_config`); a key it does not set comes from the settings `dailyFolder`, `dailyFormat` and `dailyTemplate`. Default: the vault root and `YYYY-MM-DD`.
- **Format:** Moment tokens as in templates. A `/` nests folders: `YYYY/MM/YYYY-MM-DD` gives `2026/03/2026-03-02.md`, and the folders are created. Previous and next read year, month and day (`YYYY YY MM M MMMM MMM DD D Do`) back from the paths; a format without them has no previous or next note.
- **Template:** expanded as in `Insert template` (`{{title}}` is the note name); the whole template, frontmatter included, becomes the new note. A missing template is an error and creates nothing.


## Attachments

Pasting an image or dropping a file into the editor copies it into the vault and inserts `![[name]]` at the cursor. Code: `attachments.rs` (commands `save_attachment`, `import_attachment`), `core/editor/attachment-core.ts`.

- **Folder:** `attachmentFolderPath` of `.obsidian/app.json`: missing, empty or `/` is the vault root; `./` is the folder of the open note; `./sub` a subfolder of it; any other value a fixed vault folder. The folder is created when missing; a path that leads out of the vault is refused.
- **Names:** a pasted image is `Pasted image YYYYMMDDHHmmss.png` (the extension follows the image type); a pasted or dropped file keeps its name. A taken name gets a number (`name 1.png`), nothing is overwritten.
- **Links:** the link holds the file name, or the vault-relative path when another file of the vault has the same name.
- **Dropped files inside the vault** are not copied; only the link is inserted. Dropping while the editor is closed still opens the file or folder.
