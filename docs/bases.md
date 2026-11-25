# Bases

A `.base` file shows the notes of the vault as a table. The format is the one of
[Obsidian Bases](https://obsidian.md/help/bases/syntax); Nixe supports a first part of it and never
writes a `.base` file.

## Opening a base

The file tree lists `.base` files, also in folders that contain nothing else that is listed. A click
opens the base in a tab of its own; a second click focuses that tab. The tab is not restored with the
layout. [Vault health](cli.md) does not count a base as an unused attachment.

## What is shown

The tab shows the first view of type `table`, one row per indexed note, sorted by path. The columns
are the entries of the view's `order`:

| Entry | Column |
| --- | --- |
| `file.name` | The name of the note without its extension; a click opens the note |
| `status`, `note.status`, `note["status"]` | The note property `status` (the name ignores case) |

Without `order` the only column is `file.name`; the same column is shown when no entry of `order` is
supported. `properties.<id>.displayName` sets the header of a column. A checkbox property shows as a
checkbox, a list as its items separated by commas, a missing property as an empty cell.

```yaml
properties:
  status:
    displayName: State
views:
  - type: table
    order:
      - file.name
      - status
```

The table follows changes in the vault, those of the `.base` file included.

## Not supported yet

These parts are read but not applied; the tab names the ones the file uses, so the table is never
silently filtered or sorted wrongly:

- `filters` (of the base and of the view), `formulas`, `summaries` (both)
- `sort`, `groupBy` and `limit` of the view
- columns of other `file.` properties and of `formula.` properties

Other keys are ignored. Switching views, other view types, editing and the CLI and MCP are not
supported.

## Errors

The tab shows a message instead of the table for invalid YAML, a file whose keys have the wrong
shape, a file without a view, a file without a `table` view and when the vault index is not
available. The failure is written to the log.

## How it works

The frontend reads the file and passes its text to the command `base_query`
([Tauri commands](backend/tauri-commands.md)). The Rust core (`src-tauri/src/bases/`) parses the YAML
and answers the view from the [vault index](architecture.md); the frontend only renders the result.
Only the answer of the newest query is shown.
