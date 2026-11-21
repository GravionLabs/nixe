# Editor

A note opens in a CodeMirror 6 editor with a **live preview** (#243): every block is drawn except the one that holds the cursor, which shows its Markdown. There is no edit mode to switch on.
**View modes** (#377): a tab shows its note in one of three modes, `EditorService.mode` (`"live" | "source" | "reading"`, derived from `reading` and `source`). The toolbar has one segmented control (a menu below 720 px) with *Live preview*, *Source* and *Reading* that shows the mode of the active tab, and a menu *Properties: Visible / Folded / Hidden* next to it that sets the setting *Properties in document*. The mode lives with the tab while the app runs; the setting *Default view for notes* (`defaultView`, replaces `sourceMode`; a stored `sourceMode: true` migrates to `source`) decides the mode of a new tab (`EditorService.applyDefaultMode`, once when the first note opens; a split copies the mode of its source tab). ⌘/Ctrl+E (`toggle-editor`) cycles live preview and source, and from the reading view returns to the editor in the mode used last; ⌘/Ctrl+Alt+E (`toggle-reading`) toggles the reading view. The commands `view-live`, `view-source` and `view-reading` back the control, the palette and View → Live Preview / Source / Reading. *Reading* is the read-only viewer: no cursor, no typing; task checkboxes still toggle the note (`task-toggle.ts`). The status bar shows *Read only* in that mode. `EditorComponent` is rendered inside `@defer`, so the CodeMirror chunk loads on first use. The mode control is disabled without an open note or while `EditorService.blocked()` (unresolved external change) holds the editor open.

## Live preview

Code: `core/editor/live-preview-core.ts` (pure line analysis) and `features/editor/live-preview.ts` (CodeMirror extension, in a compartment of `EditorComponent`).

- **Blocks as widgets**: tables, `mermaid` fences, `$$` math, callouts and lines that are only an embed or image (`![[…]]`, `![](…)`) are replaced by a widget that renders the block with the pipeline of the reading view (`MarkdownService.render`, `expandEmbeds`, `MermaidRenderer`). A block with a selection on it, its first or last character included, shows its source again; the text is never changed by this.
- **Inline syntax** outside the cursor's block is hidden: heading marks, `**`, `*`, `~~`, `==`, backticks, `[[ ]]` (and the target of `[[a|b]]`) and the `[` `](url)` of links. List markers are drawn as bullets, task items as a checkbox that toggles the `[ ]`. The cursor's block is the heading line, the list item with its continuation lines, or the paragraph up to the blank lines.
- Code fences stay source with a background.
- **Frontmatter as properties block** (#375): the frontmatter is replaced by a block widget (`PropertiesWidget`) that hosts `PropertiesComponent` (`app-properties`, created with `createComponent` through the hook `mountProperties` of `EditorComponent`). Folded it is the summary line, unfolded the list of properties; the block is 0.85 em and muted. The setting *Properties in document* (default *Folded*; a stored value is kept) and the command *Toggle properties* apply as in the reading view. *Hidden* draws nothing. The component gets the frontmatter text (`sourceText`) and hands an edit to the editor (`edited`), which replaces the frontmatter lines, so the edit goes through the editor's save and undo like typing. *Edit as source* (`editSource`) puts the cursor into the frontmatter. With the cursor in the frontmatter the YAML shows, in mono at 0.85 em (`cm-live-frontmatter`); a cursor at the very start of the note does not count, so a note opens with the block. Invalid frontmatter keeps its YAML and gets a warning widget above it. The source mode always shows the YAML; the gutter fold of the frontmatter (`folding.ts`) stays.
- **Cost**: the block scan runs when the text changes (a pure pass over the lines), inline marks only for the visible lines, widgets are drawn by CodeMirror only when they scroll into view.

- **Logic**: `core/editor/editor-core.ts` has no framework imports: `AutoSaver` (debounce),
  `ExternalChangeTracker`, the scroll mapping and the `[[wikilink]]` / `#tag` scanner.
  `EditorService` switches between viewer and editor.
- **Styling**: Lezer Markdown nodes get `cm-md-*` classes (heading sizes, bold, italic, code,
  dimmed syntax characters); wikilinks and tags get `cm-wikilink` / `cm-tag`. Colors are the app's
  CSS variables, the font size is `--nixe-note-font-size` (setting *Text size*, 14 px by default on the desktop; `defaultTextSize(platform)` in `appearance-core.ts`) times the zoom. ⌘/Ctrl+click on a wikilink opens the note.
- **Saving**: ⌘/Ctrl+S writes at once; otherwise 1 s after the last change, on blur, on note
  switch, when the editor closes and when the window closes. The write is `write_text_file`:
  temp file in the same folder, then rename; the Rust side decides which paths are allowed (vault
  root, or the folder of the open note). CRLF notes keep CRLF; notes with invalid UTF-8 are not editable.
- **External changes**: the watcher cannot tell who wrote, so every text about to be written is
  tracked: the text editor and disk agree on, plus writes in flight or finished within 2 s, are ignored; anything else (even an older text restored by `git checkout`) is foreign. A foreign change is loaded at once
  when nothing is unsaved; otherwise a bar (`role="alert"`) offers *Reload* (discards the unsaved edits), *Keep mine*
  (the next save replaces the version on disk) and *Compare*, and saving is paused until one is
  chosen. *Compare* opens a dialog (`app-external-compare`) with the line diff of the disk version
  against the editor text and the same two choices. After a reload from the bar a toast offers
  *Undo* for 10 s, which puts the discarded text back as an ordinary edit that is saved. The editor cannot be closed meanwhile; switching note or closing the window saves unsaved text to `<name> (unsaved copy).md` instead of overwriting the note.
- **Missing file**: when the watcher reports the open note and it can no longer be read and `path_exists` is false, `DocumentService.missing` is set (per tab). The tab shows its name struck through with the tooltip "File not found" (`HxTabBarItem.missing`), the pane shows a bar with *Close* and, in the editor, *Save as copy* (writes the editor text to `<name> (unsaved copy …).md`). The autosave is paused meanwhile, so the note is not re-created behind the user's back. A file that returns clears the state and resumes saving.
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
- The **file tree** follows the WAI-ARIA tree pattern (`role="tree"`, `aria-multiselectable`,
  `aria-selected`, one tab stop that moves with the focus). Up/Down, Home/End move the focus, Right
  expands a folder or enters it, Left collapses it or goes to the parent folder, letters jump to the
  next name that starts with them, Space toggles the selection of a row, Enter opens it, Delete moves
  the selection to the trash. Ctrl/Cmd-click toggles and Shift-click (or Shift with the arrows)
  extends the selection; Alt-click opens a note in a new tab. Dragging the selection onto a folder
  (or the empty area for the vault root) moves it, rewriting links as a rename does and listing the
  notes that change first. A move onto a name that is taken is refused before anything is moved.
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

## Note composer

`Extract selection to a note`, `Extract heading to a note` (the heading at the cursor and everything below it up to the next heading of the same or a higher level) and `Merge into…` are commands of the palette. Each asks for the target note (type to find one; extract also offers a typed name as a new note), lists the notes that change in a confirmation, and then runs as one batch in the backend (`vault/composer.rs`), so the watcher reports one debounced change. Code: `core/composer/`, `features/composer/`.

- **Extract:** the text goes to the end of the target (or into a new note, folders are created) and a link `[[note]]` stays; the setting `Leave an embed when extracting` leaves `![[note]]`. Links to a heading or block id that moved (`[[Source#Heading]]`, `[[#Heading]]`, `[[Source#^id]]`) name the target, `[[#Other]]` in the moved text names the source, and Markdown links with a relative path are recomputed. Not rewritten: Markdown links with a `#heading`, the frontmatter, code and comments.
- **Merge:** the open note is appended to the target without its frontmatter, every link to it names the target (in the form `newLinkFormat` asks for, heading and block kept) and the original moves to `.trash/`. The target is written first; if that fails nothing else changes.
