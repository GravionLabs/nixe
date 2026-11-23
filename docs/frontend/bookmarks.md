# Bookmarks

Quick access to the notes, headings and searches used every day.

- **Add**: the commands *Bookmark the note*, *Bookmark the heading at the top* and *Bookmark the search* (command palette; each one removes the bookmark again when it exists), *Bookmark* in the context menu of a note in the file tree, a right-click on a heading in the outline panel, and the star in the search panel.
- **Panel**: the *Bookmarks* view of the activity bar (command *Show bookmarks*). A click opens the note (at the heading) or runs the search. Drag a bookmark onto another one to place it before it, onto a group to move it into the group, onto the empty area to move it to the end. The `+` creates a group; double-click renames it.
- **Storage** (`bookmarks.rs`, `core/bookmarks/`):
  - The format is Obsidian's `bookmarks.json` (`items` with `file` — `path`, optional `subpath` like `#Heading` —, `search`, `group`). Kinds Nixe does not show (folder, graph, url) and other top-level keys are kept as they are.
  - By default the bookmarks live in `bookmarks.json` of the app data directory, one entry per vault. If the app data has no entry for the vault yet, the vault's `.nixe/bookmarks.json` (else `.obsidian/bookmarks.json`) is read to start with.
  - The setting *Write bookmarks into the vault* (off by default) makes `.nixe/bookmarks.json` the store, read and written; `.nixe/` is created when missing. `.obsidian/bookmarks.json` is read as a fallback when `.nixe/bookmarks.json` does not exist (until release 1.16.0, ADR 0007). Nothing is ever written into `.obsidian/`.
  - A file that cannot be read is not overwritten.
- **Rename**: renaming or moving a note or folder in Nixe, and a rename the file watcher reports, rewrite the paths of its bookmarks, so a renamed note keeps its bookmark.
