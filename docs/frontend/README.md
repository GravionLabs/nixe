# Frontend (`src/app/`)

Angular, standalone components, [signals](https://angular.dev/guide/signals) for all
state — no NgRx/RxJS store. `core/` holds framework-light services and pure logic;
`features/` holds the three UI components that make up the window.

```mermaid
flowchart TB
    subgraph features["features/"]
        Toolbar["ToolbarComponent"]
        Sidebar["SidebarComponent"]
        Viewer["ViewerComponent"]
    end

    subgraph core["core/"]
        subgraph file["core/file"]
            Doc["DocumentService"]
            Backend["backend.ts (invoke wrappers)"]
        end
        subgraph workspace["core/workspace"]
            WS["WorkspaceService"]
            TreeModel["tree-model.ts (pure)"]
        end
        subgraph markdown["core/markdown"]
            MdSvc["MarkdownService"]
            Renderer["markdown-renderer.ts (pure)"]
            LinkResolver["link-resolver.ts (pure)"]
            Mermaid["mermaid-renderer.ts"]
        end
        Settings["core/settings\nSettingsService"]
    end

    Toolbar --> Doc & WS & Settings
    Sidebar --> WS
    Viewer --> Doc & LinkResolver & Mermaid

    Doc --> Backend
    WS --> Backend
    WS --> TreeModel
    Doc --> MdSvc
    MdSvc --> Renderer
    MdSvc --> LinkResolver
```

## The framework-free core

`core/markdown/*` (except `markdown.service.ts`) and `core/workspace/tree-model.ts`
depend on neither Angular nor Tauri — they're plain functions/classes tested with
Vitest (`*.spec.ts` next to the source). That's what makes the
[VS Code extension outlook](../../README.md#outlook-vs-code-extension) in the top-level
README possible: that code could move into its own package unchanged.

## Services

| Service | State it owns | Notes |
| --- | --- | --- |
| `DocumentService` | `path`, `content`, `wikiRoot`, back/forward `history` | The document of one tab. The app-wide instance follows the shown tab of the focused pane (see [Tabs and split view](state-management.md#tabs-and-split-view)). |
| `TabsService` | panes, their tabs, the focused pane, the divider ratio | Every tab owns a `DocumentService`, `EditorService` and `OutlineService`. |
| `WorkspaceService` | `root`, the lazily-loaded tree (`visible` computed) | The opened folder's sidebar tree. |
| `MarkdownService` | render cache (one `MarkdownIt` instance per math on/off) | Pure `render()`, see [markdown-pipeline.md](markdown-pipeline.md). |
| `IndexService` | vault index `status`, a `revision` counter bumped on `vault-changed` | Listens to the `index-status` and `vault-changed` events. |
| `BacklinksService` | backlinks and outgoing links of the open note | Feeds the right-hand `BacklinksComponent` panel (View → Toggle Backlinks Panel, ⌘⇧B). Backlinks carry the linking line; clicking one opens the note scrolled to it. Unresolved outgoing links are marked. The section *Unlinked mentions* starts collapsed and is read when opened: the Rust index (`unlinked_mentions`) searches the other notes for the title or an alias of the note as plain text, skipping code, comments, frontmatter and existing links; the *Link* button of a mention rewrites it to `[[Title]]` (`[[Title\|text]]` when written differently) in that note (`link_mention`), and refuses when the note changed meanwhile. |
| `SearchService` | vault-wide full-text search | Feeds the left-hand `SearchComponent` panel (View → Search Vault, ⌘⇧F / Ctrl+⇧+F). Results are grouped by note with highlighted snippets; clicking a snippet opens the note at its line. Operators: `tag:#name` (also nested tags), `path:folder/`, `"exact phrase"`; other words match as prefixes. Above the results the panel shows `n results in m notes`; a selector sorts by relevance, name or modified time (the choice is kept in `localStorage`), the fold button of a note hides its snippets and the button in the summary folds all notes at once. The `?` button lists the operators; a click inserts one into the query. Hits carry `modified` (ms since epoch, from the index). Clicking a `#tag` in a note or the properties panel opens the search with `tag:#name`. With several roots in the window (#117) the panel searches all of them (`search_workspace`), shows the root of each hit and offers `root:name`. The Rust side is `index/search.rs` (commands `search_notes`, `search_workspace`). |
| `PaletteService` | the one overlay (`PaletteComponent`) for notes, commands, headings, tags, templates and recent vaults | The first character of the input picks the mode: no prefix finds notes, `>` commands, `@` headings of the open note, `#` tags (choosing one opens the search with `tag:#name`), `/` templates, `~` recent vaults; the empty input shows the prefixes as hints. Deleting the prefix changes the mode and keeps the overlay open. With an empty query the recently used entries lead (recent notes, recently run commands, recently inserted templates). ⌘/Ctrl+O opens it for notes, ⌘/Ctrl+P with `>`; the commands `insert-template` (`/`) and `open-recent` (`~`) open it in their mode. |
| `SwitcherService` | the notes the palette finds | Notes come from the index (`notes` command, with aliases), falling back to the vault file list. Matching is pure TypeScript in `core/switcher/fuzzy.ts` over file names and aliases; recently opened notes win ties and lead with an empty query. Enter with no match creates the note. `recentNotes` feeds the start page. |
| `RelatedService` | notes close to the open note | Feeds `RelatedComponent`, the *Related* tab of the right panel (command *Toggle related notes panel*; the tab shares the stored backlinks flag with *Links*, so a restart reopens the panel on *Links*). The ranking is computed in the Rust index (`related_notes`, `index/read.rs::related`): per candidate note the score adds *links both ways* 100 (or *links here*, a backlink, 60; or *linked from here*, an outgoing link, 50), 15 for each note (at most 3) that links to both the open note and the candidate (*both linked from X*, `X and n more`), and 5 per shared tag (at most 5, *n shared tags*). Entries are sorted by score, then path, and limited to 50; targets that are no note are skipped. Each entry shows its reasons, strongest first; hover shows the link preview, a click opens the note (⌘/Ctrl: new tab). |
| `OutlineService` | headings of the open note, `topLine` of the viewer or editor, the editor's live text | Feeds the right-hand `OutlineComponent`, the *Outline* tab of the right panel next to the *Links* tab (the toggle commands select their tab, and toggling the open tab closes the panel; the tab is kept in the vault state as the outline or backlinks visibility) (View → Toggle Outline Panel, ⌘⇧L). Headings are the ATX headings outside frontmatter and fenced code (`core/outline/outline-core.ts`), nested by level. A click scrolls the viewer (through `DocumentService.pendingLine`) or the editor (`EditorHandle.scrollToLine`). The viewer and the editor report their first visible line on scroll, which highlights the current heading; the editor also reports its text while typing, so the panel follows before the note is saved. Setext headings (underlined) are not listed. The outline folds: the buttons H1, H2, H3 and All fold to a level or expand everything, and a heading with children has its own fold button; while a folded heading hides the current one, it is marked instead. The folds belong to the note. The right panel is resized by its left edge (`PanelResizerComponent`, `role="separator"`, a 6px grab area, arrow keys, Home/End); the width is `SettingsService.panelWidth`, kept in the vault state, and limited so the note keeps 320px (`core/panel/panel-width.ts`). In a window too narrow for both, the panel overlays the note. |
| `PropertiesPanelComponent` | the *Properties* tab of the right panel, next to Outline, Links and Related | Command *Show properties panel* (needs an open note, works outside a vault). It lists the properties of the note in the active tab with `PropertiesComponent` in its sidebar mode (`sidebarPanel`; the inputs of the in-document block are reused): text, list and tag chips, number, checkbox and date, whatever the display setting says. It reads `OutlineService.editorText` (the live text of the editor) before `DocumentService.content`, so unsaved edits show. A change goes through `editFrontmatter` (`properties-edit.ts`, `frontmatter-edit.ts`) on the whole note text: into the editor with `EditorHandle.applyText` as one undoable change (`features/editor/text-change.ts` keeps it to the differing lines), or into the file with `DocumentService.write` when the note is not being edited. Add, rename, remove and reorder (the buttons *Move property up/down*, `PropertyEdit` kind `move`: the lines of a property swap with those of its neighbour). A note without frontmatter shows *No properties* and *Add property*, which creates the frontmatter; invalid frontmatter shows the warning and no inputs. |
| `SettingsService` | theme, math toggle, sidebar width/visibility, backlinks and outline panel visibility, last folder, recent vaults and their saved state | Persisted to `localStorage`. |

### Properties panel

`PropertiesComponent` sits above the note in the viewer and edits the frontmatter in place: one control per type (text, number, checkbox, date, list), chip inputs for `tags` and `aliases` that complete from the index (`tags` and `notes` commands), which write the other items back as stored (a number stays a number, its line and comment stay; a list with a mapping or a list item is shown read-only), and add, rename and remove of properties. A change goes through `editFrontmatter` (`core/markdown/frontmatter-edit.ts`), which edits only the lines of the changed key, so key order, comments and the formatting of the other keys stay as they are, and then through `DocumentService.write`. A note without frontmatter gets one with the first property added; a frontmatter that is not valid YAML is shown as an error and not edited. The component also draws the frontmatter in the live preview (`sourceText` input: it then hands a change to the editor instead of writing the note, see `docs/frontend/editor.md`). *Properties in document* defaults to Folded.

### Task checkboxes

A click on a task checkbox in the reading view writes `- [ ]` / `- [x]` to the file: the renderer gives every task item its source line (`data-line`), the viewer enables the checkboxes and `setTaskState` (`core/markdown/task-toggle.ts`) changes only that one character, then `DocumentService.write` saves it atomically. The viewer skips the re-render that follows its own write, so nothing jumps or reloads. Other markers such as `- [/]` are never touched. A checkbox inside an embed (`![[Note]]`, a heading or a block) writes to the embedded note: the expander records its file and the line offset of the shown part on `.embed-body`. Piped stdin content stays read-only.

A click on an image in the reading view opens it in the zoom dialog that Mermaid diagrams use (buttons, wheel zoom, drag to pan, Escape closes). The image is sized by `width`/`height`, never by a transform, so an SVG is drawn again at every zoom level and stays sharp. `decorateImages` (`core/markdown/image-zoom.ts`) makes images outside links focusable (Enter opens) and the stylesheet gives them a zoom-in cursor. An image inside a link follows the link; its dialog is in the context menu (*Open image*). For a local image the dialog also offers *Open with default app* and *Reveal in Finder/Explorer* (the file path is recovered from the asset URL by `assetFilePath`).

See [state-management.md](state-management.md) for how these interact when the user
clicks a link or expands a tree node.

## Commands and the command palette

Every action of the app is a `Command` (`id`, `title`, optional `shortcut`, optional `when`
condition) in the `CommandRegistry` (`src/app/core/commands/`). `AppComponent` registers the
built-in ones. The native menu only emits a command id (`menu` event), the webview key handler
runs the commands that declare `keys`, and the palette (⌘/Ctrl+P, the `>` mode of the one overlay) lists the commands whose
`when` holds, ranked by fuzzy match on the title, with their shortcuts; the ones run last come first. Plugins will register
into the same registry.

Every command can get a shortcut of the user's choice (Settings → Shortcuts). `ShortcutService`
(`core/commands/shortcut.service.ts`) records a key press (`bindingFromEvent` in `shortcuts-core.ts`
normalizes it: `Mod` is ⌘ on macOS and Ctrl elsewhere, ⌥ letters are read from the physical key),
shows conflicts before saving and stores only the differences from the defaults as `shortcuts` in
`settings.json` of the app config directory, never in the vault. The overrides replace the `keys`
of the webview key handler (`CommandRegistry.overrides`) and are sent to the native menu
(`set_menu_shortcuts`), so the menu shows the changed shortcuts. While a shortcut is recorded the
menu accelerators are off, so the pressed keys do not run commands.

## Note history

The sidebar view `history` (needs a Git vault; command `note-history`) lists the commits that touched the open note, the uncommitted state first (`HistoryService`, `features/history`). Older commits load in pages of 50 when the list is scrolled to its end. The side panel renders no diff: a click on a version opens the compare view in the main area (`CompareService`, see `features/compare`) with this version against the one before it (the uncommitted state against HEAD). The context menu has `Compare with current version` and `Compare with…` (the next click on a version is the second one; `Cancel` leaves the pick). `core/git/line-diff.ts` computes the line-based diff with word-level highlighting for paired lines; the compare view has a source mode (the diff) and a rendered mode (both versions rendered side by side).

The header shows the note title with its folder small below it. The timeline is grouped by day (`Now` for the uncommitted state, then Today, Yesterday, the weekday within the last week, then the date); a row shows a relative time (the exact time as tooltip) and the author only when the loaded commits have more than one. An automatic backup shows as `Automatic save`, a vault operation as an icon and a plain sentence (`timeline-format.ts`). Each commit row offers, as hover actions and in its context menu, `Restore this version`, which opens the compare view (current against the version) with a `Restore` button and the note *The current version stays in the history*. `Restore` calls `git_restore_note`: the open state of the note is committed first, then the version is written and committed as one operation commit; the history is never rewritten. A toast offers `Undo` (`undo_vault_operation`) and the compare tab closes. `Copy content` puts the selected text on the clipboard, else the whole version. Below the timeline, the collapsible `Trash` lists the notes the last 50 commits deleted (`git_deleted_notes`) as note rows with `deleted 3 weeks ago`; a filter field narrows it by title and folder, and `The trash is empty` shows without entries. A click on a row opens its last content in the compare view with a `Restore` button; `Restore` (also on the row) recreates the note with that content, opens it and refuses when a file of that name exists. While no note is open, `Recently changed` lists the notes the last 200 commits changed (`git_recent_notes`, at most 30; title, folder, relative time); a click opens the note and its history. `No versions yet` shows when there are none.

### Changes since the last sync

`git_vault_sync` reports `pulledFrom`, the commit HEAD was at before a pull that brought changes. `GitService.lastPull` keeps it and `ChangesService` lists the notes between that commit and HEAD (`git_changes_between`). The status bar then offers `n notes changed`, which opens the Git view; its `Changes since` section lists the changed, added and deleted notes with a line diff each (`ChangesComponent`) and switches the range, in a dropdown, to last sync, yesterday or last week (`git_rev_at`, 24 hours or 7 days ago) or a version picked from the vault log (`git_vault_log`: date, message, author; no commit id). The range and the picked version are kept for the session. An empty range says `Nothing changed since …`. The notes of the last pull carry a dot in the file tree until they are opened. All of this lives in memory only: a restart forgets the last pull.

### Shared blocks of the side panels

The Git view (`GitComponent`) is the plain-language panel: a header with the state in one sentence (`syncSummary`: "Everything is synced · 5 minutes ago", "3 changes not saved yet", "2 versions to send, 1 to receive"), a `Sync now` button, the branch small and ahead/behind only as tooltip. `Changes` lists the open changes; a click opens the compare view (saved version against now), the hover action `Open` (an icon button) opens the note and `Discard changes` takes its changes back. The save box has one optional field and the button `Save and sync` (`GitService.saveAndSync`: saves when there are changes, then syncs; `Save` only, when `GitStatus.hasRemote` is false). `Review` shows only while a suggestion waits. A failed sync shows `explainSyncError` (what happened and what to do); the raw text is under `Details` (`SyncState.detail`). A vault without a repository shows "This vault is not connected to Git yet" with a button that opens the settings. Author, automatic sync and the access token live in the settings section `Sync` (item kind `token`); the panel only shows a one-line notice with the link `Open sync settings` when the token is missing or rejected, or while a running sync waits for one.

Git, Changes, Review and History are built from the blocks in `src/app/shared/panel/`: `PanelSectionComponent` (a collapsible section with title, count and `panelActions`; its button carries `aria-expanded`, and with a `storageKey` the open state is kept in `localStorage` under `nixe.panel-section.<key>`), `NoteRowComponent` (title without `.md`, folder dimmed behind it, the path as tooltip, `rowActions` that show on hover and on keyboard focus), `StatusIconComponent` (New, Changed, Deleted, Renamed with tooltip) and `EmptyStateComponent` (text and an optional action). The components use `@Input`/`@Output` and `styles`, because the specs compile with JIT and without the Angular transform for signal inputs and `styleUrl`.

### Review of agent branches

`ReviewService` lists the suggestions (branches) that wait for review (`git_review_branches`): local and remote branches named with the setting `reviewBranchPrefix` (Settings > Git, default `claude/`; empty turns it off) that are ahead of the working branch. It reads again when the Git status, the index or the prefix changes, so a sync that fetches a new branch shows it. The status bar offers `n suggestions to review`, which opens the Git view; its `Suggestions` section (`ReviewComponent`) shows a card per suggestion with who, when, the number of changed notes and the messages; the branch name is only the tooltip. A click opens the review in a tab of the main area (`ReviewTabComponent`, view `review`, not stored with the layout; one such tab, it takes the suggestion that is opened). The tab lists the notes against the merge base with HEAD (`git_review_changes`) and shows the first one; a note shows the diff of the history view, source or rendered. The *Sections* view lists the blocks of changed lines (`git_review_hunks`); every note and every section is accepted or rejected, and an accepted section can be edited first and the edit undone. The decisions are saved per branch and tip (`git_review_state_save`), so an unfinished review survives a restart. *Finish review* asks (*Take over n notes and remove the suggestion*), then commits the accepted changes (`git_review_finish`), deletes the branch locally and on the remote and closes the tab; notes that conflict with changes made in the vault since are shown as *Your version* and *Suggested version* with *Keep mine* and *Use suggestion* and need a decision. The convention for the agent is in [`docs/ai-review.md`](../ai-review.md).

While a note is edited, the status bar shows its words and characters, or those of the selection (`EditorService.stats`, `countText` in `core/editor/text-stats.ts`). Frontmatter, `<!-- -->` and `%% %%` comments and fenced code blocks do not count; the title attribute shows the reading time at 200 words a minute. The editor recounts 150 ms after the last change or selection change.

With a vault and an open note the status bar shows `n backlinks` (`BacklinksService.backlinks`); a click opens the Links tab of the right panel. The bar reads the lists itself (the panel only while it is mounted) and again whenever the index changes.

## Start page

`StartComponent` (`features/start`) is the page of the empty tab, in the shell while there is only one empty tab and in the pane of every other empty tab. Without a vault it shows Open folder, Clone vault, Open file and the recent vaults; in a vault it shows the daily note, New note and Quick switcher, each with its current shortcut (`ShortcutService.display`), and the recently opened notes. The actions run commands of the `CommandRegistry`; the palette lists the other shortcuts.

The conflict bar (`ConflictBarComponent`, #242) above a note with a sync conflict offers *Merge* next to *Keep this one* and *Keep the other*. *Merge* (`ConflictMergeComponent`, an `hx-dialog`) shows both versions as shared lines and hunks marked like the review's hunk view; each hunk is taken from this note, the other one or both, and the result can be edited. *Save* writes the original, moves the copy to `.trash/` (which clears the conflict mark) and opens the original; *Cancel* changes nothing. No new command: it uses `write_text_file` and `resolve_conflict`.

The controls of the viewer (find bar, zoom dialog), toolbar, terminal tabs, Vault health, log, start page, compare view, editor and pane bars and the shared panel blocks are Helix primitives (`hx-button`, `hx-input`, `hx-select-button` for the compare mode, `hx-list` rows in Vault health); a toggle is `outlined` while on. `src/app/helix-controls.spec.ts` fails on a raw control in these templates and on a directive its component does not import.
